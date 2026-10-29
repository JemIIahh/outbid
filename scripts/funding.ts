// Read-only. Shows every address in the real-money run, what each needs, and what it holds now.
// Sends nothing and needs no confirmation flags.
import { token } from "remesso-sdk";
import { createPublicClient, formatUnits, http, parseAbi, type Address } from "viem";
import { celo } from "viem/chains";
import { CELO_MAINNET } from "../src/live.js";
import { deriveKeys, fundingWallets, rpcFrom } from "../src/chain/mainnet.js";
import { requiredFunding, shortfalls } from "../src/chain/funding.js";
import { buildRoster } from "../src/skills/claude.js";

const env = process.env;
const missing = ["OUTBID_OWNER_KEY", "OUTBID_BUYER_KEY", "OUTBID_SELLER_MNEMONIC"].filter((n) => !env[n]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}. Run: pnpm keys`);
  process.exit(1);
}

const { roster } = buildRoster({});
const keys = deriveKeys(env, { sellerNames: roster.map((r) => r.name), hirers: roster.filter((r) => r.hires).map((r) => r.name) });
const rows = requiredFunding(fundingWallets(keys));

const chain = createPublicClient({ chain: celo, transport: http(rpcFrom(env)) });
const chainId = await chain.getChainId();
if (chainId !== CELO_MAINNET) {
  console.error(`The RPC node is on chain ${chainId}, not Celo mainnet (${CELO_MAINNET}).`);
  process.exit(1);
}

const usdt = token("USDT").address as Address;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const have = new Map<string, bigint>();
for (const row of rows) have.set(row.address, await chain.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [row.address] }));

const show = (units: bigint) => formatUnits(units, 6).padStart(6);
console.log("Celo mainnet. Gas is paid in USDT, so USDT is all any address needs.\n");
console.log("role".padEnd(14), "address".padEnd(44), "needs", "  has");
for (const row of rows) console.log(row.role.padEnd(14), row.address.padEnd(44), show(row.usdt), show(have.get(row.address) ?? 0n));

const short = shortfalls(rows, (a) => have.get(a) ?? 0n);
const total = short.reduce((sum, r) => sum + r.missing, 0n);
console.log(short.length === 0 ? "\nFunded. Next: pnpm proof" : `\nSend ${formatUnits(total, 6)} USDT in total to the ${short.length} address(es) that are short. Nothing has been sent.`);
