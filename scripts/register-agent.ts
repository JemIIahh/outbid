import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, formatUnits, http, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { attributionSuffix, builderCodes } from "../src/chain/attribution.js";
import { buyToken } from "../src/skills/buy.js";

// Celo's canonical ERC-8004 identity registry; source: Celo AI agent documentation.
const registry = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
const token = buyToken(process.env);
const feeCurrency = token.feeCurrency;
const abi = parseAbi(["function register(string agentURI) returns (uint256 agentId)", "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"]);
if (!process.env.OUTBID_BUYER_KEY) throw new Error("OUTBID_BUYER_KEY is required");
const account = privateKeyToAccount(process.env.OUTBID_BUYER_KEY as `0x${string}`);
const metadata = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Outbid",
  description: "A buyer agent selects signed bids from specialist agents, pays under an onchain USDT spending policy on Celo, and verifies payment before delivery. Sellers can subcontract work; paid inference is purchased through buy.",
  services: [{ name: "web", endpoint: "https://github.com/JemIIahh/outbid" }],
  active: true, x402Support: false, supportedTrust: [],
};
const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;
const pub = createPublicClient({ chain: celo, transport: http(process.env.OUTBID_RPC_URL) });
if (await pub.getChainId() !== 42220) throw new Error("Registration requires Celo mainnet");
if (!await pub.getBytecode({ address: registry })) throw new Error("Identity registry has no bytecode");
const request = { address: registry, abi, functionName: "register" as const, args: [uri] as const, account, feeCurrency, dataSuffix: attributionSuffix(process.env) };
await mkdir("state", { recursive: true });
if (!process.argv.includes("--execute")) {
  let estimate: string;
  try { estimate = (await pub.estimateContractGas(request)).toString(); } catch { estimate = "Wallet needs funding before gas estimation"; }
  console.log(JSON.stringify({ chainId: 42220, registry, wallet: account.address, builderCodes: builderCodes(process.env), feeToken: token.symbol, estimatedGas: estimate, metadata, execute: "pnpm agent:register --execute" }, null, 2));
} else {
  if (process.env.OUTBID_REGISTER_CONFIRM !== "yes") throw new Error("Set OUTBID_REGISTER_CONFIRM=yes to authorize the agent registration transaction");
  if (existsSync("state/agent-registration-pending.json") || existsSync("web/fixtures/agent-registration.json")) throw new Error("Registration already submitted; inspect its receipt instead of registering again");
  const wallet = createWalletClient({ account, chain: celo, transport: http(process.env.OUTBID_RPC_URL) });
  await pub.simulateContract(request);
  const prepared = await wallet.prepareTransactionRequest({ to: registry, data: `${encodeFunctionData(request)}${attributionSuffix(process.env).slice(2)}`, feeCurrency });
  // Fee adapters price gas in 18 decimals; underlying USDC/USDT use six.
  const feeAdapterUnits = (prepared.gas ?? 0n) * (prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n);
  const maximumFee = (feeAdapterUnits + 999_999_999_999n) / 1_000_000_000_000n;
  if (!maximumFee || maximumFee > 50_000n) throw new Error(`Registration gas exceeds the 0.05 ${token.symbol} cap (${formatUnits(maximumFee, 6)})`);
  const serializedTransaction = await wallet.signTransaction(prepared);
  const hash = keccak256(serializedTransaction);
  await writeFile("state/agent-registration-pending.json", JSON.stringify({ hash, wallet: account.address, registry, feeToken: token.symbol, maximumFee: formatUnits(maximumFee, 6) }, null, 2));
  await wallet.sendRawTransaction({ serializedTransaction });
  console.log(`Registration submitted: https://celoscan.io/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("Registration reverted; inspect the transaction");
  const events = receipt.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase()).flatMap(log => { try { return [decodeEventLog({ abi, data: log.data, topics: log.topics })]; } catch { return []; } });
  const id = events.find(e => e.eventName === "Registered")?.args.agentId?.toString();
  if (!id) throw new Error("Registration event missing; inspect receipt before another registration");
  await mkdir("web/fixtures", { recursive: true });
  const evidence = { chainId: 42220, registry, agentId: id, wallet: account.address, transactionHash: hash, builderCodes: builderCodes(process.env), metadata, recordedAt: new Date().toISOString() };
  await writeFile("web/fixtures/agent-registration.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
