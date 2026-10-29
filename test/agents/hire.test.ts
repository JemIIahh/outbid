import { RemessoError } from "remesso-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSeller, SellerError, type Seller, type SellerConfig } from "../../src/agents/seller.js";
import { createBus, type Bus } from "../../src/arena/events.js";
import type { Rfq } from "../../src/arena/types.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { stubSkill } from "../../src/skills/skill.js";

let env: ArenaEnv;
let n = 0;

const text = "Revenue grew faster than planned across every region this quarter, and margins improved.";

function rfq(budget = "0.40"): Rfq {
  return { id: `rfq-${++n}`, task: { kind: "digest", input: text }, payer: env.owner.address, budget, deadlineMs: 5000, openedAt: Date.now() };
}

/** The partner: translates for 0.03 USDT. */
function lexOn(bus: Bus, price = "0.03"): Seller {
  return createSeller({ name: "lex", remesso: env.sellers[1]!.remesso, skills: [stubSkill("translate")], priceUsd: () => price, etaMs: 2000, bus });
}

/** The hirer: summarizes for 0.03 USDT itself and hires `partner` for the translation. */
function gistHiring(bus: Bus, partner: () => Seller, spend = env.sellers[0]!.spend, extra: Partial<SellerConfig> = {}): Seller {
  return createSeller({
    name: "gist",
    remesso: env.sellers[0]!.remesso,
    skills: [stubSkill("summarize")],
    priceUsd: () => "0.03",
    etaMs: 2200,
    bus,
    hires: { kind: "digest", own: "summarize", partner, spend },
    pendingRetryMs: 1,
    ...extra,
  });
}

async function buyerPays(seller: Seller, request: Rfq) {
  const bid = (await seller.bid(request))!;
  const paid = await env.buyer.remesso.invoices.pay(bid.invoice, { funding: "policy", policyId: env.policyId, maxDebit: bid.price });
  return { bid, evidence: { txHash: paid.hash!, policyId: env.policyId } };
}

beforeAll(async () => {
  env = await startArena({ sellerNames: ["gist", "lex"] });
});

afterAll(async () => {
  await env?.close();
});

describe("a seller that hires a partner", () => {
  it("bids for a digest at its own half plus the partner's price, and is as slow as both", async () => {
    const gist = gistHiring(createBus(), () => lexOn(createBus()));

    expect(gist.kinds).toContain("digest");
    expect(gist.quote({ kind: "digest", input: text })).toBe("0.06");
    expect(gist.quote({ kind: "extract", input: text })).toBeNull();
    expect(await gistHiring(createBus(), () => lexOn(createBus())).bid({ ...rfq(), task: { kind: "extract", input: text } })).toBeNull();

    const bid = await gist.bid(rfq());
    expect(bid).toMatchObject({ seller: "gist", price: "0.06", etaMs: 4200 });
  });

  it("does not bid on a digest when it cannot afford the partner or the partner is too dear", async () => {
    const dear = gistHiring(createBus(), () => lexOn(createBus(), "0.20"));
    expect(dear.quote({ kind: "digest", input: text })).toBeNull();
    expect(await dear.bid(rfq())).toBeNull();
  });

  it("does its half, hires and pays the partner from its own spending policy, and delivers the whole", async () => {
    const bus = createBus();
    const gist = gistHiring(bus, () => lexOn(bus));
    const request = rfq();
    const { bid, evidence } = await buyerPays(gist, request);
    const before = await env.usdtBalance(env.sellers[1]!.address);

    const delivery = await gist.fulfil(bid, evidence);

    const summary = await stubSkill("summarize").run({ kind: "summarize", input: text });
    expect(delivery.output).toBe(await stubSkill("translate").run({ kind: "translate", input: summary }));
    expect((await env.usdtBalance(env.sellers[1]!.address)) - before).toBe(30_000n);
    expect(bus.history().map((e) => e.type)).toEqual(["work.started", "hire.started", "hire.paid", "hire.delivered", "work.delivered"]);
    expect(bus.history().find((e) => e.type === "hire.started")).toMatchObject({ from: "gist", to: "lex", part: "translate" });
    expect(bus.history().find((e) => e.type === "hire.paid")).toMatchObject({ from: "gist", to: "lex", amount: "0.03" });
  });

  it("refuses to pay a partner whose invoice names someone else as payer", async () => {
    const bus = createBus();
    const lex = lexOn(bus);
    const lying: Seller = { ...lex, bid: (request) => lex.bid({ ...request, payer: env.owner.address }) };
    const gist = gistHiring(bus, () => lying);
    const { bid, evidence } = await buyerPays(gist, rfq());
    const before = await env.usdtBalance(env.sellers[1]!.address);

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ name: "SellerError", code: "hire_failed" });

    expect(await env.usdtBalance(env.sellers[1]!.address)).toBe(before);
    expect(bus.history().some((e) => e.type === "hire.paid")).toBe(false);
  });

  it("refuses to pay a partner that asks for more than it quoted", async () => {
    const bus = createBus();
    const lex = lexOn(bus, "0.06");
    const greedy: Seller = { ...lex, quote: () => "0.03" };
    const gist = gistHiring(bus, () => greedy);
    const { bid, evidence } = await buyerPays(gist, rfq());
    const before = await env.usdtBalance(env.sellers[1]!.address);

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed" });

    expect(await env.usdtBalance(env.sellers[1]!.address)).toBe(before);
  });

  it("refuses to pay an invoice that pays someone other than the partner it hired", async () => {
    const bus = createBus();
    const lex = lexOn(bus);
    const impostor: Seller = { ...lex, address: env.sellers[0]!.address };
    const gist = gistHiring(bus, () => impostor);
    const { bid, evidence } = await buyerPays(gist, rfq());

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed" });
    expect(bus.history().some((e) => e.type === "hire.paid")).toBe(false);
  });

  it("fails the hire, paying nothing, when the partner will not bid", async () => {
    const bus = createBus();
    const silent: Seller = { ...lexOn(bus), bid: async () => null };
    const gist = gistHiring(bus, () => silent);
    const { bid, evidence } = await buyerPays(gist, rfq());

    await expect(gist.fulfil(bid, evidence)).rejects.toBeInstanceOf(SellerError);
    expect(bus.history().map((e) => e.type)).toEqual(["work.started", "hire.started"]);
  });

  it.each([
    ["refused", new RemessoError("refused", "this invoice can't be paid this way now: balance too low")],
    ["uncertain", new RemessoError("timeout", "no answer from the network")],
  ])("fails the hire on a %s payment error, and does not try to pay again", async (_name, error) => {
    const bus = createBus();
    const real = env.sellers[0]!.spend;
    let attempts = 0;
    const failing = { ...real, remesso: { ...real.remesso, invoices: { ...real.remesso.invoices, pay: async () => (attempts++, Promise.reject(error)) } } as typeof real.remesso };
    const gist = gistHiring(bus, () => lexOn(bus), failing);
    const { bid, evidence } = await buyerPays(gist, rfq());
    const before = await env.usdtBalance(env.sellers[1]!.address);

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed" });

    expect(attempts).toBe(1);
    expect(await env.usdtBalance(env.sellers[1]!.address)).toBe(before);
    expect(bus.history().some((e) => e.type === "hire.paid")).toBe(false);
  });

  it("does not let one partner payment fulfil twice", async () => {
    const bus = createBus();
    const lex = lexOn(bus);
    let captured: Parameters<Seller["fulfil"]> | undefined;
    const spying: Seller = {
      ...lex,
      fulfil: (bid, evidence) => ((captured = [bid, evidence]), lex.fulfil(bid, evidence)),
    };
    const gist = gistHiring(bus, () => spying);
    const { bid, evidence } = await buyerPays(gist, rfq());
    await gist.fulfil(bid, evidence);

    await expect(lex.fulfil(...captured!)).rejects.toMatchObject({ code: "already_claimed" });
  });

  it("refuses a partner bid that is for another order, even when payer, recipient and amount match", async () => {
    const bus = createBus();
    const lex = lexOn(bus);
    const older = (await lex.bid({ ...rfq(), payer: env.sellers[0]!.address, task: { kind: "translate", input: "an older job" } }))!;
    const stale: Seller = { ...lex, bid: async () => older };
    const gist = gistHiring(bus, () => stale);
    const { bid, evidence } = await buyerPays(gist, rfq());
    const before = await env.usdtBalance(env.sellers[1]!.address);

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed", message: expect.stringMatching(/another order/) });

    expect(await env.usdtBalance(env.sellers[1]!.address)).toBe(before);
    expect(bus.history().some((e) => e.type === "hire.paid")).toBe(false);
  });

  it("asks again when the partner's payment is still pending, and pays it only once", async () => {
    const bus = createBus();
    const real = env.sellers[0]!.spend;
    let calls = 0;
    const flaky = {
      ...real,
      remesso: { ...real.remesso, invoices: { ...real.remesso.invoices, pay: (...args: Parameters<typeof real.remesso.invoices.pay>) => (++calls === 1 ? Promise.resolve({ status: "pending" } as never) : real.remesso.invoices.pay(...args)) } } as typeof real.remesso,
    };
    const gist = gistHiring(bus, () => lexOn(bus), flaky);
    const { bid, evidence } = await buyerPays(gist, rfq());
    const before = await env.usdtBalance(env.sellers[1]!.address);

    const delivery = await gist.fulfil(bid, evidence);

    expect(delivery.output.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
    expect((await env.usdtBalance(env.sellers[1]!.address)) - before).toBe(30_000n);
  });

  it("gives up on a payment that never confirms after three tries", async () => {
    const bus = createBus();
    const real = env.sellers[0]!.spend;
    let calls = 0;
    const stuck = { ...real, remesso: { ...real.remesso, invoices: { ...real.remesso.invoices, pay: async () => (calls++, { status: "pending" } as never) } } as typeof real.remesso };
    const gist = gistHiring(bus, () => lexOn(bus), stuck);
    const { bid, evidence } = await buyerPays(gist, rfq());

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed", message: expect.stringMatching(/did not confirm/) });

    expect(calls).toBe(3);
    expect(bus.history().some((e) => e.type === "hire.paid")).toBe(false);
  });

  it("does not wait forever for a partner that took the money and never delivers", async () => {
    const bus = createBus();
    const lex = lexOn(bus);
    const hanging: Seller = { ...lex, fulfil: () => new Promise(() => {}) };
    const gist = gistHiring(bus, () => hanging, env.sellers[0]!.spend, { hireTimeoutMs: 150 });
    const { bid, evidence } = await buyerPays(gist, rfq());

    await expect(gist.fulfil(bid, evidence)).rejects.toMatchObject({ code: "hire_failed", message: expect.stringMatching(/timed out/) });
  });
});
