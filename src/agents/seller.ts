import { RemessoError, token, toUnits, type Remesso, type SignedInvoice } from "remesso-sdk";
import type { Address, Hex } from "viem";
import type { Bus } from "../arena/events.js";
import { DIGEST_PARTS, type Bid, type Delivery, type Rfq, type Task, type TaskKind } from "../arena/types.js";
import type { Skill } from "../skills/skill.js";

/** Payments at or below this deliver on `included`; dearer ones wait for `finalized`. */
const INCLUDED_MAX = "0.10";

/** How many times a payment that has not confirmed is asked about again. */
const PENDING_ATTEMPTS = 3;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The event log carries a preview of what was delivered, not an unbounded payload. */
const MAX_EVENT_OUTPUT = 1200;

export interface ClaimStore {
  /** False if either key was already claimed; claims neither in that case. */
  claim(keys: { invoiceId: string; eventId: string }): boolean;
}

export function memoryClaimStore(): ClaimStore {
  const invoices = new Set<string>();
  const events = new Set<string>();
  return {
    claim({ invoiceId, eventId }) {
      if (invoices.has(invoiceId) || events.has(eventId)) return false;
      invoices.add(invoiceId);
      events.add(eventId);
      return true;
    },
  };
}

export class SellerError extends Error {
  constructor(
    readonly code: "payment_invalid" | "already_claimed" | "wrong_order" | "not_final" | "hire_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SellerError";
  }
}

/**
 * How a seller takes a job it cannot do alone: it does the `own` half of a digest itself and
 * hires `partner` (resolved lazily, since partners are created in the same loop) for the other.
 */
export type HirePlan = {
  kind: "digest";
  own: (typeof DIGEST_PARTS)[number];
  partner: () => Seller;
  /** Pays the partner: an agent key on a policy this seller owns (policy payments have no 1 USDT floor). */
  spend: { remesso: Remesso; policyId: bigint };
};

export type SellerConfig = {
  name: string;
  remesso: Remesso;
  skills: Skill[];
  priceUsd: (task: Task) => string;
  etaMs: number;
  /** Promised time for one task, when it is not the same for every kind. Defaults to `etaMs`. */
  etaFor?: (task: Task) => number;
  bus: Bus;
  claims?: ClaimStore;
  hires?: HirePlan;
  /** How long a hire may wait for the partner to bid, and again for it to deliver. Default 60 s. */
  hireTimeoutMs?: number;
  /** Wait between resumes of a hire payment that has not confirmed. Default 1000. */
  pendingRetryMs?: number;
  /** The SDK will not start a payment with under 60 s left, so bids must outlive that. */
  bidTtlSeconds?: number;
  /** How often to re-check a payment that must be finalized. Default 15 s. */
  finalityPollMs?: number;
  /** How long to wait for finalization before giving up. Default 45 min (Celo takes ~25-30). */
  finalityWaitMs?: number;
};

export interface Seller {
  name: string;
  address: Address;
  kinds: TaskKind[];
  etaMs: number;
  /** What it would charge for this task, or null if it cannot take it. */
  quote(task: Task): string | null;
  /** Null when the kind is unsupported or the price is above the RFQ budget. */
  bid(rfq: Rfq): Promise<Bid | null>;
  /**
   * Delivers only against an invoice this seller signed. `finality: "finalized"` asks for more care
   * than the price needs; it cannot ask for less. `quiet` keeps the work events off the bus, so a
   * hired partner's work does not look like the winner's delivery.
   */
  fulfil(bid: Bid, evidence: { txHash: Hex; policyId: bigint; finality?: "finalized"; quiet?: boolean }): Promise<Delivery>;
}

export function createSeller(cfg: SellerConfig): Seller {
  const address = cfg.remesso.address;
  if (!address) throw new Error(`seller ${cfg.name} needs a client with a signing account`);
  const usdt = token("USDT");
  const claims = cfg.claims ?? memoryClaimStore();
  const ttl = cfg.bidTtlSeconds ?? 120;
  /** Every invoice this seller signed, by signature: the only terms it will deliver against, whatever a caller sends later. */
  const issued = new Map<Hex, { rfqId: string; task: Task; price: string; invoice: SignedInvoice }>();

  const ownSkill = (kind: TaskKind) => cfg.skills.find((s) => s.kind === kind);
  if (cfg.hires && !ownSkill(cfg.hires.own)) throw new Error(`seller ${cfg.name} hires for a digest but has no ${cfg.hires.own} skill`);

  /** The partner's half of a digest: whichever part this seller is not doing itself. */
  const partnerPart = (plan: HirePlan) => DIGEST_PARTS.find((part) => part !== plan.own)!;

  function quote(task: Task): string | null {
    if (ownSkill(task.kind)) return cfg.priceUsd(task);
    const plan = cfg.hires;
    if (!plan || plan.kind !== task.kind) return null;
    const theirs = plan.partner().quote({ ...task, kind: partnerPart(plan) });
    if (theirs === null || toUnits(theirs, usdt) > toUnits(INCLUDED_MAX, usdt)) return null;
    return addPrices(cfg.priceUsd({ ...task, kind: plan.own }), theirs);
  }

  /** Hire the plan's partner for `sub`, pay it from this seller's spending policy, and return its work. */
  async function hire(rfqId: string, plan: HirePlan, sub: Task): Promise<string> {
    const partner = plan.partner();
    cfg.bus.emit({ type: "hire.started", rfqId, from: cfg.name, to: partner.name, part: sub.kind });
    const fail = (why: string, cause?: unknown) => new SellerError("hire_failed", `could not hire ${partner.name}: ${why}`, { cause });
    const request: Rfq = { id: `${rfqId}:${cfg.name}`, task: sub, payer: address!, budget: INCLUDED_MAX, deadlineMs: 30_000, openedAt: Date.now() };

    const limit = cfg.hireTimeoutMs ?? 60_000;
    const bid = await withTimeout(partner.bid(request), limit, `${partner.name}'s bid`).catch((cause: unknown) => {
      throw fail(`it failed to bid (${cause instanceof Error ? cause.message : String(cause)})`, cause);
    });
    if (!bid) throw fail("it would not bid");

    // Trust only the signed terms, never the partner's description of them.
    const verified = await cfg.remesso.invoices.verify(bid.invoice).catch((cause: unknown) => {
      throw fail("its invoice is not valid", cause);
    });
    if (bid.rfqId !== request.id || verified.orderId !== `${request.id}:${partner.name}`) throw fail("its invoice is for another order");
    if (verified.payer.toLowerCase() !== address!.toLowerCase()) throw fail("its invoice names someone else as payer");
    if (verified.recipient.toLowerCase() !== partner.address.toLowerCase()) throw fail("its invoice pays someone else");
    const quoted = partner.quote(sub);
    const cap = quoted === null || toUnits(quoted, usdt) > toUnits(INCLUDED_MAX, usdt) ? INCLUDED_MAX : quoted;
    if (verified.amount > toUnits(cap, usdt)) throw fail(`it asked for more than the ${cap} USDT it quoted`);

    // A payment that errors is never retried (it may have been sent). One that is merely pending is
    // asked about again with the same invoice: the SDK answers with the payment it already started.
    let hash: Hex | undefined;
    for (let attempt = 1; attempt <= PENDING_ATTEMPTS && !hash; attempt++) {
      const paid = await plan.spend.remesso.invoices
        .pay(bid.invoice, { funding: "policy", policyId: plan.spend.policyId, maxDebit: verified.amountDecimal })
        .catch((cause: unknown) => {
          throw fail(`the payment failed (${cause instanceof Error ? cause.message : String(cause)})`, cause);
        });
      if (paid.status === "confirmed" && paid.hash) hash = paid.hash;
      else if (attempt < PENDING_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, cfg.pendingRetryMs ?? 1000));
    }
    if (!hash) throw fail("the payment did not confirm");
    cfg.bus.emit({ type: "hire.paid", rfqId, from: cfg.name, to: partner.name, hash, amount: verified.amountDecimal });

    const delivery = await withTimeout(
      partner.fulfil({ ...bid, price: verified.amountDecimal }, { txHash: hash, policyId: plan.spend.policyId, quiet: true }),
      limit,
      `${partner.name}'s delivery`,
    ).catch((cause: unknown) => {
      throw fail(`it was paid but did not deliver (${cause instanceof Error ? cause.message : String(cause)})`, cause);
    });
    cfg.bus.emit({ type: "hire.delivered", rfqId, from: cfg.name, to: partner.name });
    return delivery.output;
  }

  /** A digest is its parts in order; this seller does its own part and hires the partner for the other. */
  async function runWithHire(rfqId: string, task: Task, plan: HirePlan): Promise<string> {
    const own = ownSkill(plan.own)!;
    let text = task.input;
    for (const part of DIGEST_PARTS) {
      const sub: Task = { kind: part, input: text };
      text = part === plan.own ? await own.run(sub) : await hire(rfqId, plan, sub);
    }
    return text;
  }

  return {
    name: cfg.name,
    address,
    kinds: [...cfg.skills.map((s) => s.kind), ...(cfg.hires ? [cfg.hires.kind] : [])],
    etaMs: cfg.etaMs,
    quote,

    async bid(rfq) {
      const price = quote(rfq.task);
      if (price === null || toUnits(price, usdt) > toUnits(rfq.budget, usdt)) return null;

      const invoice = await cfg.remesso.invoices.sign({
        payer: rfq.payer,
        amount: price,
        token: "USDT",
        orderId: `${rfq.id}:${cfg.name}`,
        expiresAt: Math.floor(Date.now() / 1000) + ttl,
      });
      issued.set(invoice.signature, { rfqId: rfq.id, task: rfq.task, price, invoice });
      const hiring = cfg.hires && cfg.hires.kind === rfq.task.kind && !ownSkill(rfq.task.kind);
      const etaMs = hiring ? cfg.etaMs + cfg.hires!.partner().etaMs : (cfg.etaFor?.(rfq.task) ?? cfg.etaMs);
      return { rfqId: rfq.id, seller: cfg.name, sellerAddress: address, price, etaMs, invoice };
    },

    async fulfil(bid, evidence) {
      // The caller's bid only points at an order. Task, price and invoice come from what this seller signed,
      // so a payment of someone else's invoice, or of a cheaper order's, cannot buy this order.
      const order = issued.get(bid.invoice.signature);
      if (!order || order.rfqId !== bid.rfqId) throw new SellerError("wrong_order", `no open order for ${bid.rfqId}`);
      const { task } = order;
      const skill = ownSkill(task.kind);
      const plan = !skill && cfg.hires?.kind === task.kind ? cfg.hires : undefined;
      if (!skill && !plan) throw new SellerError("wrong_order", `no open order for ${bid.rfqId}`);

      // A dear job waits for finality. The caller can ask for more care, never less.
      const dear = toUnits(order.price, usdt) > toUnits(INCLUDED_MAX, usdt);
      const finality = dear || evidence.finality === "finalized" ? "finalized" : "included";

      const check = (level: "included" | "finalized") =>
        cfg.remesso.invoices.verifyPayment(order.invoice, {
          txHash: evidence.txHash,
          policyId: evidence.policyId,
          finality: level,
        });

      // Verify at `included` first: a wrong payment is rejected at once, never waited on.
      let proof;
      try {
        proof = await check("included");
      } catch (cause) {
        throw new SellerError("payment_invalid", `payment does not settle this invoice: ${String(cause)}`, { cause });
      }
      if (finality === "finalized") await waitUntilFinal(check, cfg.finalityPollMs ?? 15_000, cfg.finalityWaitMs ?? 45 * 60_000);

      if (!claims.claim({ invoiceId: proof.invoiceId, eventId: proof.payment.eventId })) {
        throw new SellerError("already_claimed", "this payment has already been used to fulfil an order");
      }

      if (!evidence.quiet) cfg.bus.emit({ type: "work.started", rfqId: bid.rfqId, seller: cfg.name });
      const output = skill ? await skill.run(task) : await runWithHire(bid.rfqId, task, plan!);
      if (!evidence.quiet) cfg.bus.emit({ type: "work.delivered", rfqId: bid.rfqId, seller: cfg.name, output: output.slice(0, MAX_EVENT_OUTPUT) });
      return { rfqId: bid.rfqId, seller: cfg.name, output, deliveredAt: Date.now() };
    },
  };
}

/** Prices are two-decimal USDT strings; add them in whole cents so there is no float drift. */
function addPrices(a: string, b: string): string {
  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

/** True for the SDK's "included but not finalized yet" refusal, false for any other failure. */
function notFinalYet(error: unknown): boolean {
  return error instanceof RemessoError && error.code === "refused" && /finalized block/.test(error.message);
}

async function waitUntilFinal(check: (level: "finalized") => Promise<unknown>, pollMs: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await check("finalized");
      return;
    } catch (cause) {
      if (!notFinalYet(cause)) throw new SellerError("payment_invalid", `payment does not settle this invoice: ${String(cause)}`, { cause });
      if (Date.now() >= deadline) throw new SellerError("not_final", `payment did not finalize within ${Math.round(waitMs / 1000)}s`, { cause });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
