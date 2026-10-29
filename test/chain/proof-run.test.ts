import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { createBus } from "../../src/arena/events.js";
import type { Task } from "../../src/arena/types.js";
import { EXPLORER_TX, MAX_EXTRA_DIGESTS, PROOF_JOBS, runProof, spendLines } from "../../src/chain/proof.js";

type Outcome = { status: "delivered" | "aborted"; hire?: boolean };

/** Stands in for the app: each round pays once (and maybe hires), then ends the way the script says. */
function fakeApp(outcomes: Outcome[]) {
  const bus = createBus();
  const started: Task["kind"][] = [];
  return {
    bus,
    started,
    async startRound(req: { task: Task; budget: string }) {
      const outcome = outcomes[started.length] ?? { status: "delivered" as const };
      started.push(req.task.kind);
      const rfqId = `rfq-${started.length}`;
      const hash = `0x${String(started.length).padStart(64, "0")}` as Hex;
      bus.emit({ type: "rfq.opened", rfq: { id: rfqId, task: req.task, payer: "0x0000000000000000000000000000000000000001", budget: req.budget, deadlineMs: 1, openedAt: 0 } });
      setTimeout(() => {
        bus.emit({ type: "payment.sent", rfqId, seller: "Gist", hash, amount: "0.06" });
        if (outcome.hire) bus.emit({ type: "hire.paid", rfqId, from: "Gist", to: "Lex", hash: `0x${"ab".repeat(32)}` as Hex, amount: "0.03" });
        bus.emit({ type: "payment.final", rfqId, hash });
        bus.emit({ type: "round.ended", rfqId, status: outcome.status, ...(outcome.status === "aborted" ? { reason: "could not hire Lex: the payment failed (boom)" } : {}) });
      }, 0);
      return { rfqId };
    },
  };
}
const quiet = { log: () => {}, finalityPollMs: 5, finalityWaitMs: 500 };

describe("running the proof", () => {
  it("runs the three jobs and stops there when the digest was won by a winner that hired", async () => {
    const app = fakeApp([{ status: "delivered" }, { status: "delivered" }, { status: "delivered", hire: true }]);

    const result = await runProof(app, quiet);

    expect(result.failed).toBeUndefined();
    expect(app.started).toEqual(PROOF_JOBS.map((j) => j.kind));
  });

  it("stops at the first round that does not deliver and says why, spending nothing more", async () => {
    const app = fakeApp([{ status: "delivered" }, { status: "aborted" }]);
    const lines: string[] = [];

    const result = await runProof(app, { ...quiet, log: (l) => lines.push(l) });

    expect(app.started).toEqual(["summarize", "translate"]);
    expect(result.failed).toMatch(/translate/);
    expect(result.failed).toMatch(/could not hire Lex: the payment failed \(boom\)/);
    // What was already paid is still in the record the caller gets back.
    expect(result.events.filter((e) => e.type === "payment.sent")).toHaveLength(2);
  });

  it("retries the digest when nobody hired, but stops the moment a retry fails", async () => {
    const app = fakeApp([{ status: "delivered" }, { status: "delivered" }, { status: "delivered" }, { status: "aborted" }]);

    const result = await runProof(app, quiet);

    expect(app.started).toEqual(["summarize", "translate", "digest", "digest"]);
    expect(result.failed).toMatch(/digest/);
  });

  it("gives up after the extra digests when no winner ever hires", async () => {
    const app = fakeApp([]);

    const result = await runProof(app, quiet);

    expect(app.started).toHaveLength(PROOF_JOBS.length + MAX_EXTRA_DIGESTS);
    expect(result.failed).toBeUndefined();
    expect(result.events.some((e) => e.type === "hire.paid")).toBe(false);
  });
});

describe("what was spent", () => {
  it("lists every payment and hire with its Celoscan link", async () => {
    const app = fakeApp([{ status: "delivered" }, { status: "delivered" }, { status: "delivered", hire: true }]);
    const { events } = await runProof(app, quiet);

    const lines = spendLines(events);

    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("hire.paid"))).toEqual([`hire.paid  ${EXPLORER_TX}0x${"ab".repeat(32)}`]);
    expect(lines.every((l) => l.includes(EXPLORER_TX))).toBe(true);
  });
});
