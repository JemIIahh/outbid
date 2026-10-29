import type { Hex } from "viem";
import type { StampedEvent } from "./events.js";
import type { BidRejection, Task, TaskKind } from "./types.js";

export type BidView = { seller: string; price?: string; etaMs?: number; rejected?: BidRejection };

export type HireView = { from: string; to: string; part: TaskKind; amount?: string; hash?: Hex; delivered: boolean };

export type RoundView = {
  rfqId: string;
  task: Task;
  budget: string;
  status: "open" | "paid" | "delivered" | "no_winner" | "aborted";
  bids: BidView[];
  winner?: string;
  hash?: Hex;
  final: boolean;
  grade?: number;
  /** A preview of what the winner delivered. */
  output?: string;
  /** Sellers the winner hired for part of the job, in the order it hired them. */
  hires: HireView[];
};

export type LedgerState = { rounds: RoundView[]; policyRevoked: boolean };

/** Pure fold of the event log; the server snapshot and the UI both use it. */
export function reduceLedger(events: StampedEvent[]): LedgerState {
  const rounds = new Map<string, RoundView>();
  let policyRevoked = false;

  for (const event of events) {
    if (event.type === "policy.revoked") {
      policyRevoked = true;
      continue;
    }
    if (event.type === "rfq.opened") {
      const { id, task, budget } = event.rfq;
      rounds.set(id, { rfqId: id, task, budget, status: "open", bids: [], final: false, hires: [] });
      continue;
    }

    const round = rounds.get(event.rfqId);
    if (!round) continue;

    switch (event.type) {
      case "bid.received":
        round.bids.push({ seller: event.seller, price: event.price, etaMs: event.etaMs });
        break;
      case "bid.rejected":
        round.bids.push({ seller: event.seller, price: event.price, rejected: event.reason });
        break;
      case "winner.chosen":
        round.winner = event.seller;
        break;
      case "payment.sent":
        round.status = "paid";
        round.hash = event.hash;
        break;
      case "payment.final":
        round.final = true;
        break;
      case "work.delivered":
        round.status = "delivered";
        round.output = event.output;
        break;
      case "result.graded":
        round.grade = event.grade;
        break;
      case "hire.started":
        round.hires.push({ from: event.from, to: event.to, part: event.part, delivered: false });
        break;
      case "hire.paid": {
        const hire = round.hires.find((h) => h.from === event.from && h.to === event.to && !h.hash);
        if (hire) Object.assign(hire, { hash: event.hash, amount: event.amount });
        break;
      }
      case "hire.delivered": {
        const hire = round.hires.find((h) => h.from === event.from && h.to === event.to && !h.delivered);
        if (hire) hire.delivered = true;
        break;
      }
      case "round.ended":
        round.status = event.status;
        break;
    }
  }

  return { rounds: [...rounds.values()], policyRevoked };
}
