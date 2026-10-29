import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";

describe("arena environment", () => {
  let env: ArenaEnv;

  beforeAll(async () => {
    env = await startArena({ sellerNames: ["a", "b"] });
  });

  afterAll(async () => {
    await env?.close();
  });

  it("policy limits the buyer to the seller allowlist", async () => {
    const policy = await env.owner.remesso.policies.get(env.policyId);

    expect(policy.active).toBe(true);
    expect(policy.allowlistOnly).toBe(true);
    expect(policy.agent.toLowerCase()).toBe(env.buyer.address.toLowerCase());
    expect(policy.perPayment).toBe(500_000n);
    expect(policy.perDay).toBe(5_000_000n);
  });

  it("buyer pays an offline signed invoice through the policy and the seller verifies it", async () => {
    const seller = env.sellers[0]!;
    const before = await env.usdtBalance(seller.address);

    const invoice = await seller.remesso.invoices.sign({
      payer: env.owner.address,
      amount: "0.05",
      token: "USDT",
      orderId: "t1",
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    });

    const paid = await env.buyer.remesso.invoices.pay(invoice, {
      funding: "policy",
      policyId: env.policyId,
      maxDebit: "0.05",
    });
    expect(paid.status).toBe("confirmed");

    const proof = await seller.remesso.invoices.verifyPayment(invoice, {
      txHash: paid.hash!,
      policyId: env.policyId,
      finality: "included",
    });
    expect(proof.orderId).toBe("t1");

    expect((await env.usdtBalance(seller.address)) - before).toBe(50_000n);
  });

  it("refuses a second arena in the same process instead of hanging", async () => {
    await expect(startArena({ sellerNames: ["again"] })).rejects.toThrow(/once per process/);
  });
});
