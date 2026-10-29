import { describe, expect, it } from "vitest";
import { requiredFunding, shortfalls, type FundingWallets } from "../../src/chain/funding.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;

const wallets: FundingWallets = {
  owner: addr(1),
  buyer: addr(2),
  sellers: [
    { name: "Quill", address: addr(10) },
    { name: "Lex", address: addr(11), agent: addr(111) },
    { name: "Gist", address: addr(12), agent: addr(112) },
  ],
};

describe("what the real-money run needs", () => {
  it("asks for USDT only, for the owner, the buyer's agent, and each hirer's wallet and agent", () => {
    const rows = requiredFunding(wallets);

    expect(rows.map((r) => r.role)).toEqual(["owner", "buyer agent", "Lex wallet", "Lex agent", "Gist wallet", "Gist agent"]);
    expect(rows.map((r) => r.address)).toEqual([addr(1), addr(2), addr(11), addr(111), addr(12), addr(112)]);
    expect(rows.every((r) => r.usdt > 0n)).toBe(true);
    // Sellers that only get paid need nothing: verifying a payment is a read.
    expect(rows.some((r) => r.address === addr(10))).toBe(false);
  });

  it("keeps the whole run under one dollar", () => {
    const total = requiredFunding(wallets).reduce((sum, r) => sum + r.usdt, 0n);
    expect(total).toBeLessThan(1_000_000n);
  });

  it("reports who is short, and by how much", () => {
    const rows = requiredFunding(wallets);
    const have = new Map([[addr(1), rows[0]!.usdt + 5n], [addr(2), 1n]]);

    const short = shortfalls(rows, (a) => have.get(a) ?? 0n);

    expect(short.map((r) => r.role)).toEqual(["buyer agent", "Lex wallet", "Lex agent", "Gist wallet", "Gist agent"]);
    expect(short[0]).toMatchObject({ have: 1n, missing: rows[1]!.usdt - 1n });
    expect(shortfalls(rows, () => 10_000_000n)).toEqual([]);
  });
});
