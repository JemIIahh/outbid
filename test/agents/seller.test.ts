import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBus } from "../../src/arena/events.js";
import type { Rfq, Task, TaskKind } from "../../src/arena/types.js";
import { createSeller, SellerError } from "../../src/agents/seller.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { stubSkill, type Skill } from "../../src/skills/skill.js";

let env: ArenaEnv;
let n = 0;

function rfq(kind: TaskKind, budget: string): Rfq {
  return {
    id: `rfq-${++n}`,
    task: { kind, input: "Revenue grew faster than planned across every region this quarter." },
    payer: env.owner.address,
    budget,
    deadlineMs: 5000,
    openedAt: Date.now(),
  };
}

function countingSkill(kind: TaskKind): Skill & { calls: number } {
  const inner = stubSkill(kind);
  const skill = {
    kind,
    calls: 0,
    async run(task: Task) {
      skill.calls++;
      return inner.run(task);
    },
  };
  return skill;
}

beforeAll(async () => {
  env = await startArena({ sellerNames: ["quill", "marrow"] });
});

afterAll(async () => {
  await env?.close();
});

describe("seller agent", () => {
  it("bids only for kinds it supports and within the RFQ budget", async () => {
    const seller = createSeller({
      name: "quill",
      remesso: env.sellers[0]!.remesso,
      skills: [stubSkill("translate")],
      priceUsd: () => "0.05",
      etaMs: 2000,
      bus: createBus(),
    });

    expect(await seller.bid(rfq("summarize", "0.40"))).toBeNull();
    expect(await seller.bid(rfq("translate", "0.01"))).toBeNull();

    const request = rfq("translate", "0.40");
    const bid = await seller.bid(request);
    expect(bid).toMatchObject({ rfqId: request.id, seller: "quill", price: "0.05", etaMs: 2000 });
    expect(bid!.sellerAddress).toBe(env.sellers[0]!.address);
    expect(bid!.invoice.message.payer.toLowerCase()).toBe(env.owner.address.toLowerCase());
    expect(bid!.invoice.message.recipient.toLowerCase()).toBe(env.sellers[0]!.address.toLowerCase());
    expect(bid!.invoice.message.orderId).toBe(`${request.id}:quill`);
  });

  it("fulfils after a real policy payment and announces the work", async () => {
    const bus = createBus();
    const seller = createSeller({
      name: "quill",
      remesso: env.sellers[0]!.remesso,
      skills: [stubSkill("translate")],
      priceUsd: () => "0.05",
      etaMs: 2000,
      bus,
    });
    const request = rfq("translate", "0.40");
    const bid = (await seller.bid(request))!;
    const paid = await env.buyer.remesso.invoices.pay(bid.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bid.price });

    const delivery = await seller.fulfil(bid, { txHash: paid.hash!, policyId: env.policyId });

    expect(delivery.output.length).toBeGreaterThan(0);
    expect(delivery).toMatchObject({ rfqId: request.id, seller: "quill" });
    expect(bus.history().map((e) => e.type)).toEqual(["work.started", "work.delivered"]);
    expect(bus.history().at(-1)).toMatchObject({ type: "work.delivered", output: delivery.output });
  });

  it("delivers once when fulfil is called twice with the same payment", async () => {
    const skill = countingSkill("translate");
    const seller = createSeller({
      name: "marrow",
      remesso: env.sellers[1]!.remesso,
      skills: [skill],
      priceUsd: () => "0.05",
      etaMs: 2000,
      bus: createBus(),
    });
    const bid = (await seller.bid(rfq("translate", "0.40")))!;
    const paid = await env.buyer.remesso.invoices.pay(bid.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bid.price });
    const evidence = { txHash: paid.hash!, policyId: env.policyId };

    await seller.fulfil(bid, evidence);
    await expect(seller.fulfil(bid, evidence)).rejects.toMatchObject({ code: "already_claimed" });

    expect(skill.calls).toBe(1);
  });

  it("rejects a payment that belongs to a different invoice", async () => {
    const skill = countingSkill("translate");
    const seller = createSeller({
      name: "marrow",
      remesso: env.sellers[1]!.remesso,
      skills: [skill],
      priceUsd: () => "0.05",
      etaMs: 2000,
      bus: createBus(),
    });
    const bidA = (await seller.bid(rfq("translate", "0.40")))!;
    const bidB = (await seller.bid(rfq("translate", "0.40")))!;
    const paidA = await env.buyer.remesso.invoices.pay(bidA.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bidA.price });

    const attempt = seller.fulfil(bidB, { txHash: paidA.hash!, policyId: env.policyId });

    await expect(attempt).rejects.toBeInstanceOf(SellerError);
    await expect(attempt).rejects.toMatchObject({ code: "payment_invalid" });
    expect(skill.calls).toBe(0);
  });

  it("a dear job waits for finalization before delivering", async () => {
    const skill = countingSkill("translate");
    const seller = createSeller({
      name: "quill",
      remesso: env.sellers[0]!.remesso,
      skills: [skill],
      priceUsd: () => "0.12",
      etaMs: 2000,
      bus: createBus(),
      finalityPollMs: 50,
    });
    const bid = (await seller.bid(rfq("translate", "0.40")))!;
    const paid = await env.buyer.remesso.invoices.pay(bid.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bid.price });

    const delivery = seller.fulfil(bid, { txHash: paid.hash!, policyId: env.policyId });
    await new Promise((r) => setTimeout(r, 300));
    expect(skill.calls).toBe(0);

    await env.mine(64);
    await expect(delivery).resolves.toMatchObject({ seller: "quill" });
    expect(skill.calls).toBe(1);
  });

  it("gives up without delivering when a dear job's payment never finalizes", async () => {
    const skill = countingSkill("translate");
    const seller = createSeller({
      name: "marrow",
      remesso: env.sellers[1]!.remesso,
      skills: [skill],
      priceUsd: () => "0.12",
      etaMs: 2000,
      bus: createBus(),
      finalityPollMs: 50,
      finalityWaitMs: 300,
    });
    const bid = (await seller.bid(rfq("translate", "0.40")))!;
    const paid = await env.buyer.remesso.invoices.pay(bid.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bid.price });

    await expect(seller.fulfil(bid, { txHash: paid.hash!, policyId: env.policyId })).rejects.toMatchObject({ code: "not_final" });
    expect(skill.calls).toBe(0);
  });
});
