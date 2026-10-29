import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBus } from "../../src/arena/events.js";
import { runRound } from "../../src/arena/round.js";
import type { Seller } from "../../src/agents/seller.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { contextFor, sampleTask, stubSeller, waitFor } from "../helpers/round.js";

let env: ArenaEnv;

beforeAll(async () => {
  env = await startArena({ sellerNames: ["cheap", "mid", "dear", "forger-a", "forger-b", "forger-c"] });
});

afterAll(async () => {
  await env?.close();
});

const types = (bus: ReturnType<typeof createBus>) => bus.history().map((e) => e.type);
const reasons = (bus: ReturnType<typeof createBus>) =>
  Object.fromEntries(bus.history().flatMap((e) => (e.type === "bid.rejected" ? [[e.seller, e.reason]] : [])));

describe("one auction round", () => {
  it("the best-scored bid wins, is paid exactly once and delivers", async () => {
    const bus = createBus();
    const sellers = [
      stubSeller(env, 0, bus, { price: "0.03", etaMs: 3000, quality: 0.5 }),
      stubSeller(env, 1, bus, { price: "0.05", etaMs: 2000, quality: 0.8 }),
      stubSeller(env, 2, bus, { price: "0.10", etaMs: 1000, quality: 1 }),
    ];
    const ctx = contextFor(env, bus, sellers);
    const before = await Promise.all(env.sellers.slice(0, 3).map((s) => env.usdtBalance(s.address)));

    const result = await runRound(ctx, { task: sampleTask(), budget: "0.20" });

    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({ status: "delivered", winner: "mid" });
    const after = await Promise.all(env.sellers.slice(0, 3).map((s) => env.usdtBalance(s.address)));
    expect(after.map((a, i) => a - before[i]!)).toEqual([0n, 50_000n, 0n]);

    const all = types(bus);
    expect(all[0]).toBe("rfq.opened");
    expect(all.filter((t) => t === "bid.received")).toHaveLength(3);
    expect(all.slice(all.indexOf("winner.chosen"))).toEqual([
      "winner.chosen",
      "payment.sent",
      "payment.included",
      "work.started",
      "work.delivered",
      "result.graded",
      "round.ended",
    ]);
    expect(ctx.reputation.get(sellers[1]!.address)).toMatchObject({ jobs: 1 });
    expect(result.grade).toBeCloseTo(0.8, 1);
  });

  it("ends without paying when nobody bids", async () => {
    const bus = createBus();
    const sellers = [stubSeller(env, 0, bus, { price: "0.05", etaMs: 1000 })];
    const ownerBefore = await env.usdtBalance(env.owner.address);

    const result = await runRound(contextFor(env, bus, sellers), { task: sampleTask("extract"), budget: "0.40" });

    expect(result).toMatchObject({ status: "no_winner" });
    expect(types(bus)).not.toContain("payment.sent");
    expect(await env.usdtBalance(env.owner.address)).toBe(ownerBefore);
  });

  it("rejects forged and stale bids before any money moves", async () => {
    const bus = createBus();
    const honest = stubSeller(env, 0, bus, { price: "0.10", etaMs: 1000 });

    const wrongPayer = stubSeller(env, 3, bus, { price: "0.01", etaMs: 500 });
    const tampered = stubSeller(env, 4, bus, { price: "0.01", etaMs: 500 });
    const impostor = stubSeller(env, 5, bus, { price: "0.01", etaMs: 500 });
    const stale = stubSeller(env, 2, bus, { price: "0.01", etaMs: 500 });

    const forgers: Seller[] = [
      { ...wrongPayer, bid: (rfq) => wrongPayer.bid({ ...rfq, payer: env.buyer.address }) },
      {
        ...tampered,
        bid: async (rfq) => {
          const bid = (await tampered.bid(rfq))!;
          return { ...bid, invoice: { ...bid.invoice, message: { ...bid.invoice.message, amount: "1" } } };
        },
      },
      {
        ...impostor,
        bid: async (rfq) => ({ ...(await impostor.bid(rfq))!, sellerAddress: env.sellers[0]!.address }),
      },
      { ...stale, bid: (rfq) => stale.bid({ ...rfq, id: "old-rfq" }) },
    ];
    const forgerWallets = [3, 4, 5, 2].map((i) => env.sellers[i]!.address);
    const before = await Promise.all(forgerWallets.map((a) => env.usdtBalance(a)));

    const result = await runRound(contextFor(env, bus, [honest, ...forgers]), { task: sampleTask(), budget: "0.40" });

    expect(result).toMatchObject({ status: "delivered", winner: "cheap" });
    expect(reasons(bus)).toEqual({
      "forger-a": "wrong_payer",
      "forger-b": "invalid_signature",
      "forger-c": "wrong_recipient",
      dear: "wrong_order",
    });
    expect(await Promise.all(forgerWallets.map((a) => env.usdtBalance(a)))).toEqual(before);
  });

  it("ignores bids above the RFQ budget and bids that arrive after the window", async () => {
    const bus = createBus();
    const honest = stubSeller(env, 0, bus, { price: "0.10", etaMs: 1000 });

    const greedy = stubSeller(env, 3, bus, { price: "0.60", etaMs: 500 });
    const slow = stubSeller(env, 4, bus, { price: "0.05", etaMs: 500 });
    const sellers: Seller[] = [
      honest,
      { ...greedy, bid: (rfq) => greedy.bid({ ...rfq, budget: "5" }) },
      {
        ...slow,
        bid: async (rfq) => {
          await new Promise((r) => setTimeout(r, 800));
          return slow.bid(rfq);
        },
      },
    ];

    const result = await runRound(contextFor(env, bus, sellers, { bidWindowMs: 300 }), { task: sampleTask(), budget: "0.40" });

    expect(result).toMatchObject({ status: "delivered", winner: "cheap" });
    expect(reasons(bus)).toEqual({ "forger-a": "over_budget", "forger-b": "late" });
  });

  it("delivers a dear job only after its payment finalizes, and announces the finality", async () => {
    const bus = createBus();
    const dear = stubSeller(env, 2, bus, { price: "0.12", etaMs: 1000, finalityPollMs: 50 });
    const ctx = contextFor(env, bus, [dear], { finalityPollMs: 50 });

    const run = runRound(ctx, { task: sampleTask(), budget: "0.40" });
    await waitFor(bus, "payment.included");
    await new Promise((r) => setTimeout(r, 300));
    expect(types(bus)).not.toContain("work.started");

    await env.mine(64);
    const result = await run;
    await waitFor(bus, "payment.final");

    expect(result).toMatchObject({ status: "delivered", winner: "dear" });
    expect(types(bus).filter((t) => t === "payment.final")).toHaveLength(1);
  });
});
