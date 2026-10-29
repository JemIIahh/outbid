import { createRemesso, RemessoError, type Remesso } from "remesso-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBus, type Bus } from "../../src/arena/events.js";
import { runRound } from "../../src/arena/round.js";
import { createSeller, type Seller } from "../../src/agents/seller.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { stubSkill } from "../../src/skills/skill.js";
import { contextFor, sampleTask, stubSeller } from "../helpers/round.js";

const types = (bus: Bus) => bus.history().map((e) => e.type);
const refusedSellers = (bus: Bus) => bus.history().flatMap((e) => (e.type === "payment.refused" ? [e.seller] : []));

type Pay = Remesso["invoices"]["pay"];
const withPay = (real: Remesso, pay: Pay): Remesso => ({ ...real, invoices: { ...real.invoices, pay } }) as Remesso;

describe("payment fallback", () => {
  let env: ArenaEnv;

  beforeAll(async () => {
    env = await startArena({ sellerNames: ["pricey", "cheap", "other"] });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("falls back to the next bid when the top bid exceeds the policy cap", async () => {
    const bus = createBus();
    const pricey = stubSeller(env, 0, bus, { price: "0.60", etaMs: 1000 });
    const cheap = stubSeller(env, 1, bus, { price: "0.10", etaMs: 3000 });
    const ctx = contextFor(env, bus, [pricey, cheap]);
    // A trusted but dear seller outranks the cheap one, yet the policy caps one payment at 0.50.
    ctx.reputation.record(pricey.address, { grade: 1, onTime: true, price: "0.60" });
    const before = await Promise.all([pricey, cheap].map((s) => env.usdtBalance(s.address)));

    const result = await runRound(ctx, { task: sampleTask(), budget: "1.00" });

    expect(result).toMatchObject({ status: "delivered", winner: "cheap" });
    expect(refusedSellers(bus)).toEqual(["pricey"]);
    const order = types(bus).filter((t) => ["winner.chosen", "payment.refused", "payment.sent"].includes(t));
    expect(order).toEqual(["winner.chosen", "payment.refused", "winner.chosen", "payment.sent"]);
    const after = await Promise.all([pricey, cheap].map((s) => env.usdtBalance(s.address)));
    expect(after.map((a, i) => a - before[i]!)).toEqual([0n, 100_000n]);
  });

  it("refuses a seller outside the allowlist and uses the next bid", async () => {
    const bus = createBus();
    const outsider: Seller = createSeller({
      name: "outsider",
      remesso: createRemesso({ account: privateKeyToAccount(generatePrivateKey()), rpcUrl: env.rpcUrl, functionsUrl: env.functionsUrl }),
      skills: [stubSkill("translate")],
      priceUsd: () => "0.02",
      etaMs: 1000,
      bus,
    });
    const insider = stubSeller(env, 1, bus, { price: "0.08", etaMs: 3000 });

    const result = await runRound(contextFor(env, bus, [outsider, insider]), { task: sampleTask(), budget: "0.40" });

    expect(result).toMatchObject({ status: "delivered", winner: "cheap" });
    expect(refusedSellers(bus)).toEqual(["outsider"]);
    expect(await env.usdtBalance(outsider.address)).toBe(0n);
  });

  it("ends aborted when every ranked bid is refused", async () => {
    const bus = createBus();
    const pricey = stubSeller(env, 0, bus, { price: "0.60", etaMs: 1000 });

    const result = await runRound(contextFor(env, bus, [pricey]), { task: sampleTask(), budget: "1.00" });

    expect(result.status).toBe("aborted");
    expect(result.reason).toMatch(/no bid could be paid/);
    expect(types(bus)).not.toContain("work.started");
  });

  it("never pays a second bid after a pending payment", async () => {
    const bus = createBus();
    const first = stubSeller(env, 1, bus, { price: "0.04", etaMs: 1000 });
    const second = stubSeller(env, 2, bus, { price: "0.09", etaMs: 3000 });
    const paidOrders: string[] = [];
    const pay = (async (invoice: { message: { orderId: string } }) => {
      paidOrders.push(invoice.message.orderId);
      return { status: "pending" };
    }) as unknown as Pay;

    const ctx = contextFor(env, bus, [first, second], { buyer: withPay(env.buyer.remesso, pay), pendingRetryMs: 0 });
    const result = await runRound(ctx, { task: sampleTask(), budget: "0.40" });

    expect(result.status).toBe("aborted");
    expect(result.reason).toMatch(/payment_pending/);
    expect(paidOrders).toHaveLength(3);
    expect(new Set(paidOrders)).toEqual(new Set([paidOrders[0]]));
    expect(paidOrders[0]).toMatch(/:cheap$/);
  });

  it("never pays a second bid after an uncertain failure", async () => {
    const bus = createBus();
    const first = stubSeller(env, 1, bus, { price: "0.04", etaMs: 1000 });
    const second = stubSeller(env, 2, bus, { price: "0.09", etaMs: 3000 });
    let calls = 0;
    const pay = (async () => {
      calls++;
      throw new RemessoError("timeout", "the RPC did not answer");
    }) as unknown as Pay;

    const ctx = contextFor(env, bus, [first, second], { buyer: withPay(env.buyer.remesso, pay) });
    const result = await runRound(ctx, { task: sampleTask(), budget: "0.40" });

    expect(result.status).toBe("aborted");
    expect(result.reason).toMatch(/payment_uncertain/);
    expect(calls).toBe(1);
    expect(types(bus)).not.toContain("payment.refused");
  });

  it("keeps an RPC address and its key out of the event feed when a payment fails", async () => {
    const bus = createBus();
    const only = stubSeller(env, 1, bus, { price: "0.04", etaMs: 1000 });
    const pay = (async () => {
      throw new RemessoError("timeout", "HTTP request failed.\n\nURL: https://celo.example.com/v2/SECRETKEY\nRequest body: {}");
    }) as unknown as Pay;

    const ctx = contextFor(env, bus, [only], { buyer: withPay(env.buyer.remesso, pay) });
    const result = await runRound(ctx, { task: sampleTask(), budget: "0.40" });

    expect(result.status).toBe("aborted");
    expect(JSON.stringify(bus.history())).not.toContain("SECRETKEY");
    expect(result.reason).toMatch(/payment_uncertain: HTTP request failed/);
  });
});
