import type { Hex } from "viem";
import type { BidRejection, Rfq, ScoreRow, TaskKind } from "./types.js";

export type ArenaEvent =
  | { type: "rfq.opened"; rfq: Rfq }
  | { type: "bid.received"; rfqId: string; seller: string; price: string; etaMs: number }
  | { type: "bid.rejected"; rfqId: string; seller: string; reason: BidRejection; price?: string }
  | { type: "winner.chosen"; rfqId: string; seller: string; price: string; scores: ScoreRow[] }
  | { type: "payment.sent"; rfqId: string; seller: string; hash: Hex; amount: string }
  | { type: "payment.refused"; rfqId: string; seller: string; reason: string }
  | { type: "payment.included" | "payment.final"; rfqId: string; hash: Hex }
  | { type: "work.started"; rfqId: string; seller: string }
  | { type: "work.delivered"; rfqId: string; seller: string; output: string }
  | { type: "result.graded"; rfqId: string; seller: string; grade: number }
  // A paid winner hires another seller for part of the job and pays it from its own wallet.
  | { type: "hire.started"; rfqId: string; from: string; to: string; part: TaskKind }
  | { type: "hire.paid"; rfqId: string; from: string; to: string; hash: Hex; amount: string }
  | { type: "hire.delivered"; rfqId: string; from: string; to: string }
  | { type: "policy.revoked" }
  | { type: "round.ended"; rfqId: string; status: "delivered" | "no_winner" | "aborted"; reason?: string };

export type StampedEvent = ArenaEvent & { seq: number; at: number };

export type Bus = {
  emit(event: ArenaEvent): StampedEvent;
  subscribe(listener: (event: StampedEvent) => void): () => void;
  history(): StampedEvent[];
};

export function createBus(now: () => number = Date.now): Bus {
  const events: StampedEvent[] = [];
  const listeners = new Set<(event: StampedEvent) => void>();

  return {
    emit(event) {
      const stamped = { ...event, seq: events.length + 1, at: now() } as StampedEvent;
      events.push(stamped);
      for (const listener of [...listeners]) listener(stamped);
      return stamped;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    history: () => [...events],
  };
}
