// SPIKE (Task 11): can a paid seller become a policy owner and subcontract part of the job?
// Answers the spec's open question. Throwaway in spirit: it proves feasibility, nothing more.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";

let env: ArenaEnv;

beforeAll(async () => {
  env = await startArena({ sellerNames: ["winner", "worker", "sub"] });
});
afterAll(async () => {
  await env?.close();
});

async function setBalance(address: string, hexWei: string) {
  const res = await fetch(env.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, hexWei] }),
  });
  expect(((await res.json()) as { error?: unknown }).error).toBeUndefined();
}

describe("subcontracting spike", () => {
  it("a seller that was paid creates its own policy and a worker key pays a sub-seller", async () => {
    const [winner, worker, sub] = env.sellers as [typeof env.sellers[0], typeof env.sellers[0], typeof env.sellers[0]];
    const expiresAt = () => Math.floor(Date.now() / 1000) + 120;

    // 1. The winner earns 0.08 USDT from the owner's policy, as in a normal round.
    const job = await winner.remesso.invoices.sign({ payer: env.owner.address, amount: "0.08", token: "USDT", orderId: "job-1", expiresAt: expiresAt() });
    await env.buyer.remesso.invoices.pay(job, { funding: "policy", policyId: env.policyId, maxDebit: "0.08" });
    expect(await env.usdtBalance(winner.address)).toBe(80_000n);

    // 2. The winner owns a policy naming its worker key, allowed to pay only the sub-seller.
    // (A plain anvil fork can't pay gas in USDT, Celo's fee-currency extension, so fund CELO here.)
    await setBalance(winner.address, "0x56bc75e2d63100000");
    const policy = await winner.remesso.policies.create({
      agent: worker.address,
      token: "USDT",
      perPayment: "0.05",
      perDay: "0.05",
      days: 1,
      budget: "0.05",
      recipients: [sub.address],
    });

    // 3. The sub-seller bills the winner; the worker key (funded with CELO for gas) pays it.
    await setBalance(worker.address, "0x56bc75e2d63100000");
    const invoice = await sub.remesso.invoices.sign({ payer: winner.address, amount: "0.03", token: "USDT", orderId: "job-1:part-2", expiresAt: expiresAt() });
    const paid = await worker.remesso.invoices.pay(invoice, { funding: "policy", policyId: policy.id, maxDebit: "0.03" });
    expect(paid.status).toBe("confirmed");

    // 4. The sub-seller verifies against the winner's policy, and the money moved from the winner.
    const proof = await sub.remesso.invoices.verifyPayment(invoice, { txHash: paid.hash!, policyId: policy.id, finality: "included" });
    expect(proof.orderId).toBe("job-1:part-2");
    expect(await env.usdtBalance(sub.address)).toBe(30_000n);
    expect(await env.usdtBalance(winner.address)).toBeLessThanOrEqual(50_000n);
  });
});
