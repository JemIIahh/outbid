import type { SignedInvoice } from "remesso-sdk";
import type { Address } from "viem";

export type TaskKind = "translate" | "summarize" | "extract" | "digest";

/** A digest is the summary of the text, translated into French: its two halves, in the order they happen. */
export const DIGEST_PARTS = ["summarize", "translate"] as const satisfies readonly TaskKind[];
export type Task = { kind: TaskKind; input: string };

/** Request for quotes. `payer` is the funds owner every bid must name. */
export type Rfq = {
  id: string;
  task: Task;
  payer: Address;
  budget: string;
  deadlineMs: number;
  openedAt: number;
};

export type Bid = {
  rfqId: string;
  seller: string;
  sellerAddress: Address;
  price: string;
  etaMs: number;
  invoice: SignedInvoice;
};

export type Delivery = { rfqId: string; seller: string; output: string; deliveredAt: number };

export type Outcome = { grade: number; onTime: boolean; price: string };

export type BidRejection =
  | "invalid_signature"
  | "expired"
  | "wrong_payer"
  | "wrong_recipient"
  | "over_budget"
  | "wrong_order"
  | "late";

export type ScoreRow = {
  seller: string;
  price: string;
  etaMs: number;
  score: number;
  parts: { price: number; speed: number; record: number };
};
