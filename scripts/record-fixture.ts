// Records real rounds from the local fork into web/fixtures/round.json so the UI can be
// designed and shown without running anything. Every event, hash and score is genuine.
import { writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import type { StampedEvent } from "../src/arena/events.js";
import type { TaskKind } from "../src/arena/types.js";

const JOBS: { kind: TaskKind; budget: string; input: string }[] = [
  {
    kind: "summarize",
    budget: "0.20",
    input:
      "The committee reviewed the quarterly numbers and agreed that revenue growth was ahead of plan across every region, while margins also improved thanks to lower shipping costs.",
  },
  { kind: "translate", budget: "0.15", input: "Good morning. The shipment arrives on Friday and the invoice is attached to this message." },
  {
    kind: "extract",
    budget: "0.20",
    input: "Maria Okafor signed the lease for the Lagos warehouse on 3 March, paying a deposit of 4,500 USDT through the escrow contract.",
  },
  // The last job is a digest with a tight budget: only a pair that splits it can come in under it,
  // so the winner hires the other specialist and pays it from its own spending limit.
  {
    kind: "digest",
    budget: "0.10",
    input: "Customers praised the new checkout flow, but several reported that the confirmation email arrived late and that refunds took longer than the promised three days.",
  },
];

const app = await createApp({ ...process.env, OUTBID_ADVERSARY: "1" }, { finalityPollMs: 400 });
try {
  const ended = (rfqId: string) =>
    new Promise<void>((resolve) => {
      const off = app.bus.subscribe((e) => e.type === "round.ended" && e.rfqId === rfqId && (off(), resolve()));
    });

  for (const job of JOBS) {
    const { rfqId } = await app.startRound({ task: { kind: job.kind, input: job.input }, budget: job.budget });
    await ended(rfqId);
    console.log(`round ${rfqId} (${job.kind}) done`);
  }

  await app.fastForward();
  const wanted = app.bus.history().filter((e) => e.type === "payment.sent").length;
  for (let i = 0; i < 60 && app.bus.history().filter((e) => e.type === "payment.final").length < wanted; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const events: StampedEvent[] = app.bus.history();
  const state = await app.state();
  await writeFile("web/fixtures/round.json", JSON.stringify({ recordedAt: new Date().toISOString(), mode: app.mode, state, events }, null, 1));
  const count = (t: string) => events.filter((e) => e.type === t).length;
  console.log(`saved ${events.length} events: ${count("bid.received")} bids, ${count("bid.rejected")} rejected, ${count("payment.sent")} payments, ${count("payment.final")} final`);
} finally {
  await app.close();
}
