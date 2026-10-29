import { token, toUnits } from "remesso-sdk";
import type { Address } from "viem";
import type { Bid, Outcome, ScoreRow } from "../arena/types.js";

export type { ScoreRow };

export type Reputation = { jobs: number; avgGrade: number; onTimeRate: number };

export interface ReputationBook {
  record(seller: Address, outcome: Outcome): void;
  /** Null for a seller with no recorded jobs. */
  get(seller: Address): Reputation | null;
}

export function createReputationBook(): ReputationBook {
  const totals = new Map<string, { jobs: number; grade: number; onTime: number }>();
  return {
    record(seller, outcome) {
      const key = seller.toLowerCase();
      const t = totals.get(key) ?? { jobs: 0, grade: 0, onTime: 0 };
      totals.set(key, { jobs: t.jobs + 1, grade: t.grade + outcome.grade, onTime: t.onTime + (outcome.onTime ? 1 : 0) });
    },
    get(seller) {
      const t = totals.get(seller.toLowerCase());
      return t ? { jobs: t.jobs, avgGrade: t.grade / t.jobs, onTimeRate: t.onTime / t.jobs } : null;
    },
  };
}

export type Weights = { price: number; speed: number; record: number };
export const DEFAULT_WEIGHTS: Weights = { price: 0.5, speed: 0.2, record: 0.3 };

/** A seller with no history scores neutral, so a newcomer can still win on price. */
const UNSEEN_RECORD = 0.5;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Transparent weighted score, best first. Price: how far under budget. Speed: min-max
 * over the bids' promised ETAs. Record: 0.7 x average grade + 0.3 x on-time rate.
 * Ties go to the lower price, then the name.
 */
export function scoreBids(bids: Bid[], book: ReputationBook, budget: string, weights: Weights = DEFAULT_WEIGHTS): ScoreRow[] {
  const usdt = token("USDT");
  const budgetUnits = Number(toUnits(budget, usdt));
  const etas = bids.map((b) => b.etaMs);
  const fastest = Math.min(...etas);
  const slowest = Math.max(...etas);

  const rows = bids.map((b) => {
    const rep = book.get(b.sellerAddress);
    const parts = {
      price: clamp01(1 - Number(toUnits(b.price, usdt)) / budgetUnits),
      speed: slowest === fastest ? 1 : 1 - (b.etaMs - fastest) / (slowest - fastest),
      record: rep ? 0.7 * rep.avgGrade + 0.3 * rep.onTimeRate : UNSEEN_RECORD,
    };
    const score = weights.price * parts.price + weights.speed * parts.speed + weights.record * parts.record;
    return { seller: b.seller, price: b.price, etaMs: b.etaMs, score, parts };
  });

  return rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byPrice = Number(toUnits(a.price, usdt) - toUnits(b.price, usdt));
    return byPrice !== 0 ? byPrice : a.seller.localeCompare(b.seller);
  });
}
