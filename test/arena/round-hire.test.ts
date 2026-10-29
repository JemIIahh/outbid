import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSeller, type Seller } from "../../src/agents/seller.js";
import { createBus, type Bus } from "../../src/arena/events.js";
import { runRound } from "../../src/arena/round.js";
import { startArena, type ArenaEnv } from "../../src/chain/env.js";
import { stubSkill } from "../../src/skills/skill.js";
import { contextFor, sampleTask } from "../helpers/round.js";

let env: ArenaEnv;

beforeAll(async () => {
  env = await startArena({ sellerNames: ["gist", "lex", "dear"] });
});
afterAll(async () => {
  await env?.close();
});

const types = (bus: Bus) => bus.history().map((e) => e.type);

/** Gist summarizes for 0.03 and hires Lex (0.03) for the translation: 0.06 for a digest, cheaper and faster than Dear. */
function field(bus: Bus, lexOverride: (lex: Seller) => Seller = (lex) => lex) {
  const lex = createSeller({ name: "lex", remesso: env.sellers[1]!.remesso, skills: [stubSkill("translate")], priceUsd: () => "0.03", etaMs: 2000, bus });
  const partner = lexOverride(lex);
  const gist = createSeller({
    name: "gist",
    remesso: env.sellers[0]!.remesso,
    skills: [stubSkill("summarize")],
    priceUsd: () => "0.03",
    etaMs: 2200,
    bus,
    hires: { kind: "digest", own: "summarize", partner: () => partner, spend: env.sellers[0]!.spend },
  });
  const dear = createSeller({ name: "dear", remesso: env.sellers[2]!.remesso, skills: [stubSkill("digest")], priceUsd: () => "0.10", etaMs: 6000, bus });
  return { gist, lex: partner, dear };
}

describe("a round won by a seller that hires help", () => {
  it("pays the winner once, lets the winner pay its helper, and grades the winner only", async () => {
    const bus = createBus();
    const { gist, lex, dear } = field(bus);
    const ctx = contextFor(env, bus, [gist, lex, dear]);
    const lexBefore = await env.usdtBalance(lex.address);
    const ownerBefore = await env.usdtBalance(env.owner.address);

    const result = await runRound(ctx, { task: sampleTask("digest"), budget: "0.20" });

    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({ status: "delivered", winner: "gist" });
    expect(await env.usdtBalance(lex.address)).toBe(lexBefore + 30_000n);
    expect(await env.usdtBalance(env.owner.address)).toBeLessThan(ownerBefore);

    const all = types(bus);
    expect(all.filter((t) => t === "payment.sent")).toHaveLength(1);
    expect(all.slice(all.indexOf("payment.included"))).toEqual([
      "payment.included",
      "work.started",
      "hire.started",
      "hire.paid",
      "hire.delivered",
      "work.delivered",
      "result.graded",
      "round.ended",
    ]);
    expect(ctx.reputation.get(gist.address)).toMatchObject({ jobs: 1 });
    expect(ctx.reputation.get(lex.address)).toBeNull();
  });

  it("aborts with the reason, having paid the winner once and the helper never, when the helper will not work", async () => {
    const bus = createBus();
    const { gist, lex, dear } = field(bus, (real) => ({ ...real, bid: async () => null }));
    const ctx = contextFor(env, bus, [gist, lex, dear]);
    const lexBefore = await env.usdtBalance(lex.address);

    const result = await runRound(ctx, { task: sampleTask("digest"), budget: "0.20" });

    expect(result).toMatchObject({ status: "aborted", winner: "gist" });
    expect(result.reason).toMatch(/could not hire lex/);
    expect(await env.usdtBalance(lex.address)).toBe(lexBefore);
    const all = types(bus);
    expect(all.filter((t) => t === "payment.sent")).toHaveLength(1);
    expect(all).not.toContain("hire.paid");
    expect(all).not.toContain("result.graded");
    expect(bus.history().at(-1)).toMatchObject({ type: "round.ended", status: "aborted" });
  });

  it("aborts with the reason, with the helper paid and the winner not graded, when the helper takes the money and fails", async () => {
    const bus = createBus();
    const { gist, lex, dear } = field(bus, (real) => ({
      ...real,
      fulfil: async () => {
        throw new Error("boom");
      },
    }));
    const ctx = contextFor(env, bus, [gist, lex, dear]);

    const result = await runRound(ctx, { task: sampleTask("digest"), budget: "0.20" });

    expect(result).toMatchObject({ status: "aborted", winner: "gist" });
    expect(result.reason).toMatch(/paid but did not deliver \(boom\)/);
    const all = types(bus);
    expect(all.filter((t) => t === "payment.sent")).toHaveLength(1);
    expect(all).toContain("hire.paid");
    expect(all).not.toContain("result.graded");
    expect(ctx.reputation.get(gist.address)).toBeNull();
  });

  // Last in the file: it revokes the shared policy.
  it("still delivers when the owner revokes the buyer's policy while the winner is hiring", async () => {
    const bus = createBus();
    const { gist, lex, dear } = field(bus, (real) => ({
      ...real,
      bid: async (rfq) => {
        // Only the hire's own request (its id is "<round>:<hirer>"), not the round's bid call.
        if (rfq.id.includes(":")) await env.owner.remesso.policies.revoke(env.policyId);
        return real.bid(rfq);
      },
    }));
    const ctx = contextFor(env, bus, [gist, lex, dear]);
    const lexBefore = await env.usdtBalance(lex.address);

    const result = await runRound(ctx, { task: sampleTask("digest"), budget: "0.20" });

    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({ status: "delivered", winner: "gist" });
    // The hire was paid from the winner's own policy, so the revocation did not touch it.
    expect(await env.usdtBalance(lex.address)).toBe(lexBefore + 30_000n);
    expect(types(bus).filter((t) => t === "payment.sent")).toHaveLength(1);
  });
});
