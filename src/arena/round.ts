import { randomUUID } from "node:crypto";
import { RemessoError, token, toUnits, type Remesso, type RemessoErrorCode } from "remesso-sdk";
import type { Address, Hex } from "viem";
import { scoreBids, type ReputationBook } from "../agents/scoring.js";
import type { Seller } from "../agents/seller.js";
import type { Grader } from "../skills/skill.js";
import type { Bus } from "./events.js";
import type { Bid, BidRejection, Rfq, Task } from "./types.js";

export type ArenaContext = {
  bus: Bus;
  buyer: Remesso;
  /** The funds owner: every bid must name this address as payer. */
  owner: Address;
  policyId: bigint;
  sellers: Seller[];
  reputation: ReputationBook;
  grader: Grader;
  /** How long sellers have to answer an RFQ. Default 2000. */
  bidWindowMs?: number;
  /** Wait between resumes of a payment that has not confirmed. Default 1000. */
  pendingRetryMs?: number;
  /** How often the ledger re-checks whether a payment has finalized. Default 15 s. */
  finalityPollMs?: number;
  /** When to stop watching for finality. Default 45 min. */
  finalityTimeoutMs?: number;
};

export type RoundResult = {
  rfqId: string;
  status: "delivered" | "no_winner" | "aborted";
  winner?: string;
  hash?: Hex;
  grade?: number;
  reason?: string;
};

const LATE = Symbol("late");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof LATE> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(LATE), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

type Checked = { ok: true; bid: Bid } | { ok: false; reason: BidRejection; price?: string };

/** Trust only the signed terms: the bid's own price and address are the seller's claims. */
async function check(ctx: ArenaContext, rfq: Rfq, seller: Seller, bid: Bid): Promise<Checked> {
  const usdt = token("USDT");
  let verified;
  try {
    verified = await ctx.buyer.invoices.verify(bid.invoice, { allowExpired: true });
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (verified.expiresAt <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired", price: verified.amountDecimal };
  if (verified.payer.toLowerCase() !== ctx.owner.toLowerCase()) return { ok: false, reason: "wrong_payer", price: verified.amountDecimal };
  if (
    verified.recipient.toLowerCase() !== seller.address.toLowerCase() ||
    bid.sellerAddress.toLowerCase() !== seller.address.toLowerCase()
  ) {
    return { ok: false, reason: "wrong_recipient", price: verified.amountDecimal };
  }
  if (verified.orderId !== `${rfq.id}:${seller.name}`) return { ok: false, reason: "wrong_order", price: verified.amountDecimal };
  if (verified.amount > toUnits(rfq.budget, usdt)) return { ok: false, reason: "over_budget", price: verified.amountDecimal };
  return { ok: true, bid: { ...bid, price: verified.amountDecimal } };
}

export async function runRound(ctx: ArenaContext, req: { task: Task; budget: string; deadlineMs?: number }): Promise<RoundResult> {
  const { bus } = ctx;
  const rfq: Rfq = {
    id: `rfq-${randomUUID().slice(0, 8)}`,
    task: req.task,
    payer: ctx.owner,
    budget: req.budget,
    deadlineMs: req.deadlineMs ?? 30_000,
    openedAt: Date.now(),
  };
  bus.emit({ type: "rfq.opened", rfq });

  const accepted: Bid[] = [];
  await Promise.all(
    ctx.sellers.map(async (seller) => {
      const answer = await withTimeout(seller.bid(rfq), ctx.bidWindowMs ?? 2000).catch(() => null);
      if (answer === LATE) {
        bus.emit({ type: "bid.rejected", rfqId: rfq.id, seller: seller.name, reason: "late" });
        return;
      }
      if (answer === null) return;

      const checked = await check(ctx, rfq, seller, answer);
      if (checked.ok) {
        accepted.push(checked.bid);
        bus.emit({ type: "bid.received", rfqId: rfq.id, seller: seller.name, price: checked.bid.price, etaMs: checked.bid.etaMs });
      } else {
        bus.emit({ type: "bid.rejected", rfqId: rfq.id, seller: seller.name, reason: checked.reason, price: checked.price });
      }
    }),
  );

  if (accepted.length === 0) {
    bus.emit({ type: "round.ended", rfqId: rfq.id, status: "no_winner", reason: "no valid bids" });
    return { rfqId: rfq.id, status: "no_winner", reason: "no valid bids" };
  }

  const scores = scoreBids(accepted, ctx.reputation, rfq.budget);
  const ranked = scores.map((row) => accepted.find((b) => b.seller === row.seller)!);

  for (const bid of ranked) {
    if (await policyGone(ctx)) return abort(ctx, rfq.id, "policy revoked or expired");

    const winner = ctx.sellers.find((s) => s.name === bid.seller)!;
    bus.emit({ type: "winner.chosen", rfqId: rfq.id, seller: winner.name, price: bid.price, scores });

    const attempt = await attemptPayment(ctx, bid);
    if (attempt.kind === "uncertain") return abort(ctx, rfq.id, attempt.reason, winner.name);
    if (attempt.kind === "refused") {
      bus.emit({ type: "payment.refused", rfqId: rfq.id, seller: winner.name, reason: attempt.reason });
      continue;
    }

    const { hash } = attempt;
    const paidAt = Date.now();
    bus.emit({ type: "payment.sent", rfqId: rfq.id, seller: winner.name, hash, amount: bid.price });
    bus.emit({ type: "payment.included", rfqId: rfq.id, hash });
    watchFinality(ctx, rfq.id, bid, hash);

    try {
      const delivery = await winner.fulfil(bid, { txHash: hash, policyId: ctx.policyId });
      const grade = await ctx.grader(rfq.task, delivery.output);
      ctx.reputation.record(winner.address, { grade, onTime: delivery.deliveredAt - paidAt <= bid.etaMs, price: bid.price });
      bus.emit({ type: "result.graded", rfqId: rfq.id, seller: winner.name, grade });
      bus.emit({ type: "round.ended", rfqId: rfq.id, status: "delivered" });
      return { rfqId: rfq.id, status: "delivered", winner: winner.name, hash, grade };
    } catch (error) {
      return abort(ctx, rfq.id, error instanceof Error ? error.message : String(error), winner.name);
    }
  }

  if (await policyGone(ctx)) return abort(ctx, rfq.id, "policy revoked or expired");
  return abort(ctx, rfq.id, "no bid could be paid");
}

/**
 * Tell the ledger when a payment becomes final. Runs in the background and never fails the
 * round: errors (including the RPC going away) just mean "not final yet", until the timeout.
 */
function watchFinality(ctx: ArenaContext, rfqId: string, bid: Bid, hash: Hex): void {
  const pollMs = ctx.finalityPollMs ?? 15_000;
  const deadline = Date.now() + (ctx.finalityTimeoutMs ?? 45 * 60_000);
  const tick = async (): Promise<void> => {
    try {
      await ctx.buyer.invoices.verifyPayment(bid.invoice, { txHash: hash, policyId: ctx.policyId, finality: "finalized" });
      ctx.bus.emit({ type: "payment.final", rfqId, hash });
    } catch {
      if (Date.now() < deadline) setTimeout(tick, pollMs).unref();
    }
  };
  setTimeout(tick, pollMs).unref();
}

/** Errors thrown before anything is signed or after a revert: the money did not move. */
const NOTHING_PAID: ReadonlySet<RemessoErrorCode> = new Set(["refused", "reverted", "no_gas"]);
const PENDING_ATTEMPTS = 3;

type Attempt = { kind: "paid"; hash: Hex } | { kind: "refused"; reason: string } | { kind: "uncertain"; reason: string };

/**
 * Pay one bid. Only a definite refusal lets the caller move to the next bid; a payment
 * that is pending or failed in a way that may have sent it must never be followed by
 * another payment.
 */
async function attemptPayment(ctx: ArenaContext, bid: Bid): Promise<Attempt> {
  for (let n = 1; n <= PENDING_ATTEMPTS; n++) {
    try {
      const paid = await ctx.buyer.invoices.pay(bid.invoice, { funding: "policy", policyId: ctx.policyId, maxDebit: bid.price });
      if (paid.status === "confirmed" && paid.hash) return { kind: "paid", hash: paid.hash };
    } catch (error) {
      if (error instanceof RemessoError && NOTHING_PAID.has(error.code)) return { kind: "refused", reason: error.message };
      return { kind: "uncertain", reason: `payment_uncertain: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (n < PENDING_ATTEMPTS) await new Promise((r) => setTimeout(r, ctx.pendingRetryMs ?? 1000));
  }
  return { kind: "uncertain", reason: "payment_pending: the payment was sent but has not confirmed" };
}

async function policyGone(ctx: ArenaContext): Promise<boolean> {
  try {
    return !(await ctx.buyer.policies.get(ctx.policyId)).active;
  } catch {
    return false; // can't tell; let the payment itself decide
  }
}

function abort(ctx: ArenaContext, rfqId: string, reason: string, winner?: string): RoundResult {
  if (reason.startsWith("policy")) ctx.bus.emit({ type: "policy.revoked" });
  ctx.bus.emit({ type: "round.ended", rfqId, status: "aborted", reason });
  return { rfqId, status: "aborted", winner, reason };
}
