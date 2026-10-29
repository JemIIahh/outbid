import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBus, type Bus } from "../../src/arena/events.js";
import { runRound } from "../../src/arena/round.js";
import type { Seller } from "../../src/agents/seller.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { contextFor, sampleTask, stubSeller } from "../helpers/round.js";

const types = (bus: Bus) => bus.history().map((e) => e.type);

// Its own file: remesso-sdk keeps signer state per process, so each fork needs its own worker.
describe("policy revoked mid-round", () => {
  let env: ArenaEnv;

  beforeAll(async () => {
    env = await startArena({ sellerNames: ["cheap"] });
  });
  afterAll(async () => {
    await env?.close();
  });

  it("aborts without paying or delivering when the owner revokes before payment", async () => {
    const bus = createBus();
    const inner = stubSeller(env, 0, bus, { price: "0.05", etaMs: 1000 });
    const revoking: Seller = {
      ...inner,
      bid: async (rfq) => {
        const bid = await inner.bid(rfq);
        await env.owner.remesso.policies.revoke(env.policyId);
        return bid;
      },
    };
    const before = await env.usdtBalance(inner.address);

    const result = await runRound(contextFor(env, bus, [revoking]), { task: sampleTask(), budget: "0.40" });

    expect(result.status).toBe("aborted");
    expect(result.reason).toMatch(/policy/);
    expect(types(bus)).toContain("policy.revoked");
    expect(types(bus)).not.toContain("payment.sent");
    expect(types(bus)).not.toContain("work.started");
    expect(await env.usdtBalance(inner.address)).toBe(before);
  });
});
