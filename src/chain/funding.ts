import type { Address } from "viem";

/** 6-decimal USDT. */
const usdt = (cents: number): bigint => BigInt(cents) * 10_000n;

// Estimates. On Celo the gas for a transaction is paid in USDT (a fee currency), a fraction of a
// cent each, so the run needs no CELO. The owner also covers the jobs themselves: up to five jobs of at
// most 0.10 plus the protocol fee, with room to spare.
const NEEDS = {
  owner: usdt(80),
  buyerAgent: usdt(5),
  hirerWallet: usdt(3), // approve + create its own spending policy
  hirerAgent: usdt(3), // pay the partner it hires
};

export type FundingWallets = {
  owner: Address;
  buyer: Address;
  /** `agent` is set for sellers that hire: the key that pays their partner. */
  sellers: { name: string; address: Address; agent?: Address }[];
};

export type FundingRow = { role: string; address: Address; usdt: bigint };

/** What each address must hold before a real-money run. Sellers that only get paid need nothing. */
export function requiredFunding(w: FundingWallets): FundingRow[] {
  return [
    { role: "owner", address: w.owner, usdt: NEEDS.owner },
    { role: "buyer agent", address: w.buyer, usdt: NEEDS.buyerAgent },
    ...w.sellers.flatMap((s) =>
      s.agent
        ? [
            { role: `${s.name} wallet`, address: s.address, usdt: NEEDS.hirerWallet },
            { role: `${s.name} agent`, address: s.agent, usdt: NEEDS.hirerAgent },
          ]
        : [],
    ),
  ];
}

export type Shortfall = FundingRow & { have: bigint; missing: bigint };

export function shortfalls(rows: FundingRow[], balanceOf: (address: Address) => bigint): Shortfall[] {
  return rows.flatMap((row) => {
    const have = balanceOf(row.address);
    return have < row.usdt ? [{ ...row, have, missing: row.usdt - have }] : [];
  });
}
