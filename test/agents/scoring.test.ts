import type { SignedInvoice } from "remesso-sdk";
import { describe, expect, it } from "vitest";
import { createReputationBook, scoreBids } from "../../src/agents/scoring.js";
import type { Bid } from "../../src/arena/types.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

function bid(seller: string, n: number, price: string, etaMs = 2000): Bid {
  return { rfqId: "r1", seller, sellerAddress: addr(n), price, etaMs, invoice: {} as SignedInvoice };
}

describe("scoring", () => {
  it("ranks the cheaper of two otherwise equal bids first", () => {
    const rows = scoreBids([bid("dear", 1, "0.30"), bid("cheap", 2, "0.10")], createReputationBook(), "0.40");
    expect(rows.map((r) => r.seller)).toEqual(["cheap", "dear"]);
  });

  it("ranks the faster of two otherwise equal bids first", () => {
    const rows = scoreBids([bid("slow", 1, "0.10", 5000), bid("fast", 2, "0.10", 1000)], createReputationBook(), "0.40");
    expect(rows.map((r) => r.seller)).toEqual(["fast", "slow"]);
  });

  it("prefers a proven seller over an unseen one at equal price and speed", () => {
    const book = createReputationBook();
    book.record(addr(1), { grade: 0.9, onTime: true, price: "0.10" });

    const rows = scoreBids([bid("unseen", 2, "0.10"), bid("proven", 1, "0.10")], book, "0.40");
    expect(rows[0]!.seller).toBe("proven");
  });

  it("lets an unseen seller beat a perfect record only when cheaper by more than 30% of the budget", () => {
    const book = createReputationBook();
    book.record(addr(1), { grade: 1, onTime: true, price: "0.50" });

    const wins = scoreBids([bid("perfect", 1, "0.50"), bid("unseen", 2, "0.19")], book, "1.00");
    const loses = scoreBids([bid("perfect", 1, "0.50"), bid("unseen", 2, "0.21")], book, "1.00");

    expect(wins[0]!.seller).toBe("unseen");
    expect(loses[0]!.seller).toBe("perfect");
  });

  it("breaks an exact tie by name", () => {
    const rows = scoreBids([bid("zed", 1, "0.10"), bid("amy", 2, "0.10")], createReputationBook(), "0.40");
    expect(rows.map((r) => r.seller)).toEqual(["amy", "zed"]);
  });

  it("explains each score with its three parts", () => {
    const [row] = scoreBids([bid("solo", 1, "0.10")], createReputationBook(), "0.40");
    expect(row!.parts).toEqual({ price: 0.75, speed: 1, record: 0.5 });
    expect(row!.score).toBeCloseTo(0.5 * 0.75 + 0.2 * 1 + 0.3 * 0.5, 10);
  });
});

describe("reputation book", () => {
  it("returns null for a seller it has never seen", () => {
    expect(createReputationBook().get(addr(9))).toBeNull();
  });

  it("averages grades and on-time rate over several outcomes", () => {
    const book = createReputationBook();
    book.record(addr(1), { grade: 1, onTime: true, price: "0.10" });
    book.record(addr(1), { grade: 0.5, onTime: false, price: "0.10" });

    expect(book.get(addr(1))).toEqual({ jobs: 2, avgGrade: 0.75, onTimeRate: 0.5 });
  });
});
