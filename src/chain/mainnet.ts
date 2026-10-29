import { createRemesso, token, type Remesso } from "remesso-sdk";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount, type HDAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { CELO_MAINNET, preflight } from "../live.js";
import { AGENT_INDEX_BASE, type ChainEnv, type Spend, type Wallet } from "./env.js";
import { requiredFunding, shortfalls, type FundingWallets } from "./funding.js";
import { createPolicies, type PolicyStep } from "./policies.js";

/** What the buyer may spend in the real-money run: nothing above 0.10 at a time, nothing above 1.00 in all. */
const BUYER_POLICY = { perPayment: "0.10", perDay: "1.00", days: 1, budget: "1" } as const;
/** What a hiring seller may spend on help. */
const HIRE_POLICY = { perPayment: "0.10", perDay: "0.30", days: 1, budget: "0.30" } as const;

const DEFAULT_RPC = "https://forno.celo.org";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export type MainnetRoster = { sellerNames: string[]; hirers: string[] };

type Keys = {
  owner: PrivateKeyAccount;
  buyer: PrivateKeyAccount;
  sellers: { name: string; account: HDAccount; agent?: HDAccount }[];
};

/** Derive every account from the environment. Reads nothing from the network and sends nothing. */
export function deriveKeys(env: Record<string, string | undefined>, roster: MainnetRoster): Keys {
  const phrase = env.OUTBID_SELLER_MNEMONIC!;
  return {
    owner: privateKeyToAccount(env.OUTBID_OWNER_KEY as `0x${string}`),
    buyer: privateKeyToAccount(env.OUTBID_BUYER_KEY as `0x${string}`),
    sellers: roster.sellerNames.map((name, i) => ({
      name,
      account: mnemonicToAccount(phrase, { addressIndex: i }),
      agent: roster.hirers.includes(name) ? mnemonicToAccount(phrase, { addressIndex: AGENT_INDEX_BASE + i }) : undefined,
    })),
  };
}

export const fundingWallets = (keys: Keys): FundingWallets => ({
  owner: keys.owner.address,
  buyer: keys.buyer.address,
  sellers: keys.sellers.map((s) => ({ name: s.name, address: s.account.address, agent: s.agent?.address })),
});

export const rpcFrom = (env: Record<string, string | undefined>, rpcUrl?: string) => rpcUrl ?? env.OUTBID_RPC_URL ?? DEFAULT_RPC;

/**
 * Start the real-money environment on Celo mainnet. It refuses, before any network call, unless
 * the owner confirmed spending and every key is private; it refuses a node that is not Celo
 * mainnet; and it refuses unless every wallet already holds the USDT it needs. Only then does it
 * send transactions: the buyer's policy, and one small policy for each seller that hires.
 */
export async function startMainnet(env: Record<string, string | undefined>, opts: MainnetRoster & { rpcUrl?: string }): Promise<ChainEnv> {
  const early = preflight(env, CELO_MAINNET);
  if (!early.ok) throw new Error(`not starting on mainnet:\n- ${early.problems.join("\n- ")}`);

  const rpcUrl = rpcFrom(env, opts.rpcUrl);
  const chain = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const chainId = await chain.getChainId();
  if (chainId !== CELO_MAINNET) throw new Error(`not starting on mainnet: chain ${chainId} is not Celo mainnet (${CELO_MAINNET})`);

  const keys = deriveKeys(env, opts);
  const usdt = token("USDT").address as Address;
  const balances = new Map<string, bigint>();
  const rows = requiredFunding(fundingWallets(keys));
  for (const row of rows) balances.set(row.address, await chain.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [row.address] }));
  const short = shortfalls(rows, (a) => balances.get(a) ?? 0n);
  if (short.length) throw new Error(`not starting on mainnet: underfunded (run pnpm funding): ${short.map((r) => `${r.role} is ${r.missing} short`).join(", ")}`);

  const client = (account: PrivateKeyAccount | HDAccount): Remesso => createRemesso({ account, rpcUrl });
  const wallet = (name: string, account: PrivateKeyAccount | HDAccount): Wallet => ({ name, address: account.address, remesso: client(account) });
  const owner = wallet("owner", keys.owner);
  const buyer = wallet("buyer", keys.buyer);

  const sellerAddresses = keys.sellers.map((s) => s.account.address);
  const sellerWallets = keys.sellers.map((s) => wallet(s.name, s.account));
  const steps: PolicyStep[] = [
    {
      label: "buyer",
      create: async () => (await owner.remesso.policies.create({ agent: buyer.address, token: "USDT", ...BUYER_POLICY, recipients: sellerAddresses })).id,
      revoke: (id) => owner.remesso.policies.revoke(id),
    },
    ...keys.sellers.flatMap((s, i) =>
      s.agent
        ? [
            {
              label: s.name,
              create: async () =>
                (await sellerWallets[i]!.remesso.policies.create({
                  agent: s.agent!.address,
                  token: "USDT",
                  ...HIRE_POLICY,
                  recipients: sellerAddresses.filter((a) => a !== s.account.address),
                })).id,
              revoke: (id: bigint) => sellerWallets[i]!.remesso.policies.revoke(id),
            },
          ]
        : [],
    ),
  ];
  // If any policy fails, the ones already created are revoked before the error comes out.
  const made = await createPolicies(steps);
  const policyIdOf = (label: string) => made.policies.find((p) => p.label === label)!.id;

  const sellers: ChainEnv["sellers"] = keys.sellers.map((s, i) => {
    const spend: Spend | undefined = s.agent ? { remesso: client(s.agent), policyId: policyIdOf(s.name) } : undefined;
    return { ...sellerWallets[i]!, ...(spend ? { spend } : {}) };
  });

  return {
    network: "mainnet",
    rpcUrl,
    owner,
    buyer,
    sellers,
    policyId: policyIdOf("buyer"),
    policies: made.policies,
    usdtBalance: (address) => chain.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [address] }),
    // Nothing keeps spending authority once the run is over.
    close: async () => {
      const stuck = await made.revokeAll();
      if (stuck.length) throw new Error(`could not revoke: ${stuck.join(", ")}; revoke these yourself`);
    },
  };
}
