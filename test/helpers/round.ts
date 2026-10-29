import type { ArenaContext } from "../../src/arena/round.js";
import type { Bus } from "../../src/arena/events.js";
import type { TaskKind } from "../../src/arena/types.js";
import { createReputationBook } from "../../src/agents/scoring.js";
import { createSeller, type Seller } from "../../src/agents/seller.js";
import type { ArenaEnv } from "../../src/chain/env.js";
import { stubGrader, stubSkill } from "../../src/skills/skill.js";

export function stubSeller(
  env: ArenaEnv,
  index: number,
  bus: Bus,
  o: { price: string; etaMs: number; quality?: number; kind?: TaskKind; finalityPollMs?: number },
): Seller {
  const wallet = env.sellers[index]!;
  return createSeller({
    name: wallet.name,
    remesso: wallet.remesso,
    skills: [stubSkill(o.kind ?? "translate", { quality: o.quality })],
    priceUsd: () => o.price,
    etaMs: o.etaMs,
    bus,
    finalityPollMs: o.finalityPollMs,
  });
}

export function contextFor(env: ArenaEnv, bus: Bus, sellers: Seller[], extra: Partial<ArenaContext> = {}): ArenaContext {
  return {
    bus,
    buyer: env.buyer.remesso,
    owner: env.owner.address,
    policyId: env.policyId,
    sellers,
    reputation: createReputationBook(),
    grader: stubGrader,
    ...extra,
  };
}

export const sampleTask = (kind: TaskKind = "translate") => ({
  kind,
  input: "Revenue grew faster than planned across every region this quarter, and margins improved.",
});

/** Resolves with the first event of `type` (already emitted or yet to come), or rejects after `ms`. */
export function waitFor(bus: Bus, type: string, ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (bus.history().some((e) => e.type === type)) return resolve();
    const timer = setTimeout(() => (off(), reject(new Error(`no ${type} event within ${ms}ms`))), ms);
    const off = bus.subscribe((e) => {
      if (e.type === type) (clearTimeout(timer), off(), resolve());
    });
  });
}
