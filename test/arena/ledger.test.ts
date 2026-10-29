import { describe, expect, it } from "vitest";
import { createBus, type ArenaEvent } from "../../src/arena/events.js";
import { reduceLedger } from "../../src/arena/ledger.js";
import type { Rfq } from "../../src/arena/types.js";

const payer = "0x0000000000000000000000000000000000000001" as const;
const hash = `0x${"ab".repeat(32)}` as const;

const rfq: Rfq = {
  id: "r1",
  task: { kind: "summarize", input: "a long text" },
  payer,
  budget: "0.40",
  deadlineMs: 5000,
  openedAt: 0,
};

function fold(events: ArenaEvent[]) {
  const bus = createBus(() => 0);
  events.forEach((e) => bus.emit(e));
  return reduceLedger(bus.history());
}

describe("ledger reducer", () => {
  it("folds a full successful round into one delivered, final round", () => {
    const state = fold([
      { type: "rfq.opened", rfq },
      { type: "bid.received", rfqId: "r1", seller: "A", price: "0.10", etaMs: 3000 },
      { type: "bid.received", rfqId: "r1", seller: "B", price: "0.20", etaMs: 1000 },
      { type: "bid.rejected", rfqId: "r1", seller: "C", reason: "over_budget" },
      { type: "winner.chosen", rfqId: "r1", seller: "A", price: "0.10", scores: [] },
      { type: "payment.sent", rfqId: "r1", seller: "A", hash, amount: "0.10" },
      { type: "payment.included", rfqId: "r1", hash },
      { type: "work.delivered", rfqId: "r1", seller: "A", output: "a short summary" },
      { type: "result.graded", rfqId: "r1", seller: "A", grade: 0.9 },
      { type: "payment.final", rfqId: "r1", hash },
      { type: "round.ended", rfqId: "r1", status: "delivered" },
    ]);

    expect(state.rounds).toHaveLength(1);
    const round = state.rounds[0]!;
    expect(round).toMatchObject({ rfqId: "r1", status: "delivered", winner: "A", hash, final: true, grade: 0.9, budget: "0.40", output: "a short summary" });
    expect(round.bids).toHaveLength(3);
    expect(round.bids.find((b) => b.seller === "C")?.rejected).toBe("over_budget");
    expect(round.bids.find((b) => b.seller === "A")).toMatchObject({ price: "0.10", etaMs: 3000 });
  });

  it("shows a paid but not yet final round as paid", () => {
    const state = fold([
      { type: "rfq.opened", rfq },
      { type: "winner.chosen", rfqId: "r1", seller: "A", price: "0.10", scores: [] },
      { type: "payment.sent", rfqId: "r1", seller: "A", hash, amount: "0.10" },
    ]);

    expect(state.rounds[0]).toMatchObject({ status: "paid", final: false, hash });
  });

  it("marks a round with no valid bids as no_winner", () => {
    const state = fold([
      { type: "rfq.opened", rfq },
      { type: "round.ended", rfqId: "r1", status: "no_winner" },
    ]);

    expect(state.rounds[0]).toMatchObject({ status: "no_winner", bids: [] });
  });

  it("records a revoked policy", () => {
    expect(fold([{ type: "policy.revoked" }]).policyRevoked).toBe(true);
    expect(fold([]).policyRevoked).toBe(false);
  });

  it("records who the winner hired, what it paid them and that they delivered", () => {
    const helperHash = `0x${"cd".repeat(32)}` as const;
    const state = fold([
      { type: "rfq.opened", rfq: { ...rfq, task: { kind: "digest", input: "a long text" } } },
      { type: "winner.chosen", rfqId: "r1", seller: "A", price: "0.07", scores: [] },
      { type: "payment.sent", rfqId: "r1", seller: "A", hash, amount: "0.07" },
      { type: "hire.started", rfqId: "r1", from: "A", to: "H", part: "translate" },
      { type: "hire.paid", rfqId: "r1", from: "A", to: "H", hash: helperHash, amount: "0.03" },
      { type: "hire.delivered", rfqId: "r1", from: "A", to: "H" },
    ]);

    expect(state.rounds[0]!.hires).toEqual([{ from: "A", to: "H", part: "translate", amount: "0.03", hash: helperHash, delivered: true }]);
  });

  it("shows a hire that has started but not been paid", () => {
    const state = fold([
      { type: "rfq.opened", rfq },
      { type: "hire.started", rfqId: "r1", from: "A", to: "H", part: "summarize" },
    ]);

    expect(state.rounds[0]!.hires).toEqual([{ from: "A", to: "H", part: "summarize", delivered: false }]);
  });

  it("gives a round that hired nobody an empty hire list", () => {
    expect(fold([{ type: "rfq.opened", rfq }]).rounds[0]!.hires).toEqual([]);
  });
});
