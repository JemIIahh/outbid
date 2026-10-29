import { formatAmount } from "remesso-sdk";
import { createReputationBook } from "./agents/scoring.js";
import { createSeller, type Seller } from "./agents/seller.js";
import { createBus, type Bus } from "./arena/events.js";
import { reduceLedger } from "./arena/ledger.js";
import { runRound, type ArenaContext } from "./arena/round.js";
import type { Task } from "./arena/types.js";
import { startArena, type ChainEnv } from "./chain/env.js";
import { BusyError, type StateSnapshot } from "./server/app.js";
import { buildRoster } from "./skills/claude.js";
import { stubSkill } from "./skills/skill.js";

const fail = (message: string): never => {
  throw new Error(message);
};

export type App = {
  env: ChainEnv;
  bus: Bus;
  mode: "claude" | "stub";
  state(): Promise<StateSnapshot>;
  /** Resolves once the RFQ is open; throws `BusyError` if a round is already running. */
  startRound(req: { task: Task; budget: string }): Promise<{ rfqId: string }>;
  revoke(): Promise<void>;
  /** Only the local fork can skip ahead to finality; on mainnet you wait. */
  fastForward: (() => Promise<void>) | undefined;
  close(): Promise<void>;
};

/** Starts the chain the app runs on. The default is a local fork; the proof run passes mainnet. */
export type StartChain = (roster: { sellerNames: string[]; hirers: string[] }) => Promise<ChainEnv>;
const localFork: StartChain = (roster) => startArena({ sellerNames: roster.sellerNames });

/**
 * The whole demo in one process: a local fork, the seller roster, the buyer's policy and the
 * event bus. With OUTBID_ADVERSARY=1 two cheating sellers join to show bids being rejected:
 * Sly names the wrong payer, Fakir tampers with the signed amount.
 */
export async function createApp(
  processEnv: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ArenaContext> = {},
  startChain: StartChain = localFork,
): Promise<App> {
  const { roster, grader, mode } = buildRoster(processEnv);
  const adversary = processEnv.OUTBID_ADVERSARY === "1";

  const env = await startChain({
    sellerNames: [...roster.map((r) => r.name), ...(adversary ? ["Sly", "Fakir"] : [])],
    hirers: roster.filter((r) => r.hires).map((r) => r.name),
  });
  const bus = createBus();
  const reputation = createReputationBook();

  const sellers: Seller[] = roster.map((entry, i) =>
    createSeller({
      name: entry.name,
      remesso: env.sellers[i]!.remesso,
      skills: entry.skills,
      priceUsd: entry.priceUsd,
      etaMs: entry.etaMs,
      etaFor: entry.etaFor,
      bus,
      // Partners are looked up when needed: every seller exists by the time a round runs.
      hires: entry.hires && {
        kind: entry.hires.kind,
        own: entry.hires.own,
        partner: () => sellers.find((s) => s.name === entry.hires!.partner)!,
        spend: env.sellers[i]!.spend ?? fail(`${entry.name} hires help but has no spending policy`),
      },
    }),
  );

  if (adversary) {
    const cheater = (name: string, index: number) =>
      createSeller({
        name,
        remesso: env.sellers[index]!.remesso,
        skills: (["translate", "summarize", "extract"] as const).map((kind) => stubSkill(kind)),
        priceUsd: () => "0.01",
        etaMs: 400,
        bus,
      });
    const sly = cheater("Sly", roster.length);
    const fakir = cheater("Fakir", roster.length + 1);
    sellers.push({ ...sly, bid: (rfq) => sly.bid({ ...rfq, payer: env.buyer.address }) });
    sellers.push({
      ...fakir,
      bid: async (rfq) => {
        const bid = await fakir.bid(rfq);
        return bid && { ...bid, invoice: { ...bid.invoice, message: { ...bid.invoice.message, amount: "1" } } };
      },
    });
  }

  const ctx: ArenaContext = { bus, buyer: env.buyer.remesso, owner: env.owner.address, policyId: env.policyId, sellers, reputation, grader, ...overrides };
  // Busy from startRound until the round announces its end. Releasing on the event (not when the
  // promise settles) lets a UI that reacts to round.ended start the next round immediately.
  let running = false;
  bus.subscribe((event) => {
    if (event.type === "round.ended") running = false;
  });

  return {
    env,
    bus,
    mode,
    async state() {
      const policy = await env.owner.remesso.policies.get(env.policyId);
      const usdt = (units: bigint) => formatAmount(units, "USDT");
      return {
        ledger: reduceLedger(bus.history()),
        mode,
        network: env.network,
        policy: {
          active: policy.active,
          revoked: policy.revoked,
          spendable: usdt(policy.spendable),
          remainingToday: usdt(policy.remainingToday),
          perPayment: usdt(policy.perPayment),
          perDay: usdt(policy.perDay),
        },
        sellers: sellers.map((s) => ({ name: s.name, address: s.address, kinds: s.kinds, etaMs: s.etaMs, reputation: reputation.get(s.address) })),
      };
    },
    startRound(req) {
      if (running) throw new BusyError();
      running = true;
      return new Promise((resolve, reject) => {
        const off = bus.subscribe((event) => {
          if (event.type === "rfq.opened") (off(), resolve({ rfqId: event.rfq.id }));
        });
        runRound(ctx, req)
          .catch((error: unknown) => {
            off();
            running = false;
            console.error("round failed:", error);
            reject(error);
          });
      });
    },
    async revoke() {
      await env.owner.remesso.policies.revoke(env.policyId);
      bus.emit({ type: "policy.revoked" });
    },
    fastForward: env.mine && (() => env.mine!(64)),
    close: () => env.close(),
  };
}
