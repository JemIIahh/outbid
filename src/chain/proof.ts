import type { Bus, StampedEvent } from "../arena/events.js";
import type { Task, TaskKind } from "../arena/types.js";
import { CELO_MAINNET, preflight } from "../live.js";

export const PROOF_FILE = "web/fixtures/proof.json";
export const EXPLORER_TX = "https://celoscan.io/tx/";

/** Three small jobs, each under the 0.10 USDT that delivers as soon as the payment is included. */
export const PROOF_JOBS: { kind: TaskKind; budget: string; input: string }[] = [
  {
    kind: "summarize",
    budget: "0.10",
    input:
      "The committee reviewed the quarterly numbers and agreed that revenue growth was ahead of plan across every region, while margins also improved thanks to lower shipping costs.",
  },
  { kind: "translate", budget: "0.10", input: "Good morning. The shipment arrives on Friday and the invoice is attached to this message." },
  {
    kind: "digest",
    budget: "0.10",
    input:
      "Customers praised the new checkout flow, but several reported that the confirmation email arrived late and that refunds took longer than the promised three days.",
  },
];

/** If no specialist won the digest (so nobody hired anyone), try the digest again, at most this many times. */
export const MAX_EXTRA_DIGESTS = 2;

export type ProofStart = { ok: true } | { ok: false; problems: string[] };

/** Everything that must hold before the proof run is allowed to spend. Reads only its inputs. */
export function checkProofStart(env: Record<string, string | undefined>, proofExists: boolean): ProofStart {
  const problems: string[] = [];
  const base = preflight(env, CELO_MAINNET);
  if (!base.ok) problems.push(...base.problems);
  if (!env.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY is required: a proof with stand-in agents would show placeholder work");
  if (proofExists && env.OUTBID_PROOF_AGAIN !== "1") {
    problems.push(`${PROOF_FILE} already exists: running again spends real money again. Set OUTBID_PROOF_AGAIN=1 to replace it`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export type ProofApp = {
  bus: Bus;
  startRound(req: { task: Task; budget: string }): Promise<{ rfqId: string }>;
};
export type ProofResult = { events: StampedEvent[]; failed?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the proof jobs, one at a time. It stops at the first auction that does not deliver, so no
 * more money is spent, and says why. Whatever happened, the caller gets every event back, so the
 * payments already made can be listed.
 */
export async function runProof(
  app: ProofApp,
  opts: { log?: (line: string) => void; finalityPollMs?: number; finalityWaitMs?: number } = {},
): Promise<ProofResult> {
  const log = opts.log ?? console.log;
  const count = (type: string) => app.bus.history().filter((e) => e.type === type).length;

  const ended = (rfqId: string) =>
    new Promise<{ status: string; reason?: string }>((resolve) => {
      const done = (e: StampedEvent) => (e.type === "round.ended" && e.rfqId === rfqId ? { status: e.status, reason: e.reason } : null);
      const already = app.bus.history().map(done).find(Boolean);
      if (already) return resolve(already);
      const off = app.bus.subscribe((e) => {
        const result = done(e as StampedEvent);
        if (result) (off(), resolve(result));
      });
    });

  /** Returns why the round did not deliver, or undefined if it did. */
  const run = async (job: (typeof PROOF_JOBS)[number]): Promise<string | undefined> => {
    const { rfqId } = await app.startRound({ task: { kind: job.kind, input: job.input }, budget: job.budget });
    const { status, reason } = await ended(rfqId);
    log(`${job.kind}: ${status}${reason ? ` (${reason})` : ""}`);
    return status === "delivered" ? undefined : `the ${job.kind} auction ended ${status}${reason ? `: ${reason}` : ""}`;
  };
  const result = (failed?: string): ProofResult => ({ events: app.bus.history(), ...(failed ? { failed } : {}) });

  for (const job of PROOF_JOBS) {
    const failed = await run(job);
    if (failed) return result(failed);
  }

  // The point is a winner that hires: if a generalist won the digest, try the digest again.
  const digest = PROOF_JOBS.find((j) => j.kind === "digest")!;
  for (let extra = 0; extra < MAX_EXTRA_DIGESTS && count("hire.paid") === 0; extra++) {
    const failed = await run(digest);
    if (failed) return result(failed);
  }

  const wanted = count("payment.sent");
  log(`${wanted + count("hire.paid")} payments sent. Waiting for them to finalize (about 30 minutes on Celo)...`);
  const deadline = Date.now() + (opts.finalityWaitMs ?? 60 * 60_000);
  while (count("payment.final") < wanted && Date.now() < deadline) await sleep(opts.finalityPollMs ?? 60_000);
  return result();
}

/** One line per real payment, each with its Celoscan link. */
export function spendLines(events: StampedEvent[]): string[] {
  return events.flatMap((e) => (e.type === "payment.sent" || e.type === "hire.paid" ? [`${e.type}  ${EXPLORER_TX}${e.hash}`] : []));
}
