import { createRemesso, token, type Remesso } from "remesso-sdk";
import { assertLocalAnvil, startDev } from "remesso-sdk/dev";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { celo } from "viem/chains";

// Public test phrase for seller keys, distinct from the dev environment's own.
// Never fund these keys on a real network.
const SELLER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

const POLICY = { perPayment: "0.50", perDay: "5.00", days: 1, budget: "5" } as const;
/** What a seller may spend on hired help: one sub-job is at most 0.10 USDT. */
const HIRE_POLICY = { perPayment: "0.10", perDay: "1.00", days: 1, budget: "1" } as const;
/** Seller agent keys sit well above the seller wallets in the same phrase. */
export const AGENT_INDEX_BASE = 100;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Gas money for seller wallets that pay other agents. A plain anvil fork cannot pay gas in USDT. */
const SELLER_GAS_WEI = "0x56bc75e2d63100000"; // 100 CELO

/** A fork-only JSON-RPC call. Refuses to talk to anything that is not a local anvil. */
async function anvil(rpcUrl: string, method: string, params: unknown[]): Promise<void> {
  await assertLocalAnvil(rpcUrl);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
}

export type Wallet = { name: string; address: Address; remesso: Remesso };

/** A seller's own small spending policy, so it can pay the agents it hires (policy payments have no 1 USDT floor). */
export type Spend = { remesso: Remesso; policyId: bigint };
export type SellerWallet = Wallet & { spend: Spend };

/** What the app needs from a chain, whether it is the local fork or Celo mainnet. */
export type ChainEnv = {
  network: "fork" | "mainnet";
  rpcUrl: string;
  /** Only the dev fork points at its own backend; mainnet uses the SDK's default. */
  functionsUrl?: string;
  /** Holds the funds and owns the buyer's policy. */
  owner: Wallet;
  /** The policy agent that signs the buyer's payments. */
  buyer: Wallet;
  /** `spend` is set for sellers that hire: the policy they pay their partner from. */
  sellers: (Wallet & { spend?: Spend })[];
  policyId: bigint;
  /** Every spending policy this run created on a real network (empty on the fork). */
  policies?: { label: string; id: bigint }[];
  usdtBalance(address: Address): Promise<bigint>;
  /** Fork only: mines blocks. On the fork a block is final once 64 newer blocks exist. */
  mine?(blocks: number): Promise<void>;
  close(): Promise<void>;
};

export interface ArenaEnv extends ChainEnv {
  network: "fork";
  functionsUrl: string;
  sellers: SellerWallet[];
  mine(blocks: number): Promise<void>;
}

// remesso-sdk keeps signer state (nonces, pending sends) for the life of the process. A second
// fork's first transaction would wait on the first fork's state and hang, so refuse up front.
let started = false;

export async function startArena(opts: { sellerNames?: string[] } = {}): Promise<ArenaEnv> {
  if (started) throw new Error("startArena can run once per process: remesso-sdk keeps signer state, so a second fork would hang. Start a new process.");
  started = true;
  const names = opts.sellerNames ?? ["seller-1", "seller-2", "seller-3"];
  const dev = await startDev();
  try {
    const accounts = names.map((_, i) => mnemonicToAccount(SELLER_MNEMONIC, { addressIndex: i }));
    const agents = names.map((_, i) => mnemonicToAccount(SELLER_MNEMONIC, { addressIndex: AGENT_INDEX_BASE + i }));
    const client = (account: (typeof accounts)[number]) => createRemesso({ account, rpcUrl: dev.rpcUrl, functionsUrl: dev.functionsUrl });

    for (const account of [...accounts, ...agents]) await anvil(dev.rpcUrl, "anvil_setBalance", [account.address, SELLER_GAS_WEI]);

    const sellers: SellerWallet[] = [];
    for (const [i, name] of names.entries()) {
      const remesso = client(accounts[i]!);
      const { id } = await remesso.policies.create({
        agent: agents[i]!.address,
        token: "USDT",
        ...HIRE_POLICY,
        recipients: accounts.filter((_, j) => j !== i).map((a) => a.address),
      });
      sellers.push({ name, address: accounts[i]!.address, remesso, spend: { remesso: client(agents[i]!), policyId: id } });
    }

    const { id: policyId } = await dev.clients.treasury.policies.create({
      agent: dev.accounts.buyer,
      token: "USDT",
      ...POLICY,
      recipients: sellers.map((s) => s.address),
    });

    const chain = createPublicClient({ chain: celo, transport: http(dev.rpcUrl) });
    const usdt = token("USDT").address as Address;

    return {
      network: "fork",
      rpcUrl: dev.rpcUrl,
      functionsUrl: dev.functionsUrl,
      owner: { name: "owner", address: dev.accounts.treasury, remesso: dev.clients.treasury },
      buyer: { name: "buyer", address: dev.accounts.buyer, remesso: dev.clients.buyer },
      sellers,
      policyId,
      usdtBalance: (address) => chain.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [address] }),
      mine: (blocks) => anvil(dev.rpcUrl, "anvil_mine", [`0x${blocks.toString(16)}`]),
      close: () => dev.close(),
    };
  } catch (error) {
    await dev.close();
    throw error;
  }
}
