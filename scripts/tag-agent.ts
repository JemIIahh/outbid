import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fromDataSuffix } from "@celo/attribution-tags";
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, http, keccak256, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { attributionSuffix } from "../src/chain/attribution.js";
import { buyToken } from "../src/skills/buy.js";

const tag = process.env.OUTBID_ATTRIBUTION_CODE;
if (!tag) throw new Error("Copy the Loops-assigned OUTBID_ATTRIBUTION_CODE before sending any transaction");
if (!process.env.OUTBID_BUYER_KEY) throw new Error("OUTBID_BUYER_KEY is required");
const account = privateKeyToAccount(process.env.OUTBID_BUYER_KEY as `0x${string}`);
const token = buyToken(process.env);
const registration = JSON.parse(await readFile("web/fixtures/agent-registration.json", "utf8"));
const registry = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
const agentId = BigInt(registration.agentId);
if (registration.wallet.toLowerCase() !== account.address.toLowerCase() || registration.registry.toLowerCase() !== registry.toLowerCase()) throw new Error("Recorded agent does not match this wallet and registry");
const pub = createPublicClient({ chain: celo, transport: http(process.env.OUTBID_RPC_URL) });
if (await pub.getChainId() !== 42220) throw new Error("Celo mainnet is required");
const abi = parseAbi(["function ownerOf(uint256 agentId) view returns(address)", "function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)", "function getMetadata(uint256 agentId, string metadataKey) view returns(bytes)"]);
if ((await pub.readContract({ address: registry, abi, functionName: "ownerOf", args: [agentId] })).toLowerCase() !== account.address.toLowerCase()) throw new Error("Buyer wallet does not own this agent");
const value = toHex(JSON.stringify({ event: "agents-on-open-rails", attributionTag: tag, repository: "https://github.com/JemIIahh/outbid" }));
const request = { address: registry, abi, functionName: "setMetadata" as const, args: [agentId, "outbid.hackathon", value] as const, account, feeCurrency: token.feeCurrency, dataSuffix: attributionSuffix(process.env) };
const proofFile = "web/fixtures/attribution-proof.json";
const previous = existsSync(proofFile) ? JSON.parse(await readFile(proofFile, "utf8")) : undefined;
const pendingFile = `state/agent-tag-${tag}-pending.json`;
if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ action: "Attach Loops attribution to the existing ERC-8004 agent", agentId: agentId.toString(), assignedTag: tag, feeToken: token.symbol, maximumFee: "0.02" }, null, 2));
} else {
  if (process.env.OUTBID_TAG_CONFIRM !== "yes") throw new Error("Set OUTBID_TAG_CONFIRM=yes after authorizing the identity metadata update");
  const resume = process.argv.includes("--resume");
  let hash: `0x${string}`;
  if (resume) {
    const pending = JSON.parse(await readFile(pendingFile, "utf8"));
    if (pending.assignedTag !== tag) throw new Error("Pending transaction belongs to another entry tag");
    hash = pending.hash;
  } else {
    if (previous?.assignedTag === tag || existsSync(pendingFile)) throw new Error("A tag update already exists; use --resume to verify it without another transaction");
    if (previous && !process.argv.includes("--rebind")) throw new Error("Changing the entry tag requires an explicit --rebind after verifying the enrolled account");
    await pub.simulateContract(request);
    const wallet = createWalletClient({ account, chain: celo, transport: http(process.env.OUTBID_RPC_URL) });
    const prepared = await wallet.prepareTransactionRequest({ to: registry, data: `${encodeFunctionData(request)}${attributionSuffix(process.env).slice(2)}`, feeCurrency: token.feeCurrency });
    const fee = ((prepared.gas ?? 0n) * (prepared.maxFeePerGas ?? prepared.gasPrice ?? 0n) + 999_999_999_999n) / 1_000_000_000_000n;
    if (!fee || fee > 20_000n) throw new Error("Identity metadata update exceeds its 0.02 stablecoin fee cap");
    const serializedTransaction = await wallet.signTransaction(prepared);
    hash = keccak256(serializedTransaction);
    await mkdir("state", { recursive: true });
    await writeFile(pendingFile, JSON.stringify({ hash, assignedTag: tag, maximumFee: formatUnits(fee, 6), token: token.symbol }, null, 2));
    await wallet.sendRawTransaction({ serializedTransaction });
  }
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`Identity metadata update reverted: ${hash}`);
  const tx = await pub.getTransaction({ hash });
  const decoded = fromDataSuffix(tx.input);
  const stored = await pub.readContract({ address: registry, abi, functionName: "getMetadata", args: [agentId, "outbid.hackathon"], blockNumber: receipt.blockNumber });
  if (!decoded?.codes.includes(tag) || stored !== value) throw new Error("Attribution or stored metadata could not be verified");
  const evidence = { chainId: 42220, agentId: agentId.toString(), wallet: account.address, assignedTag: tag, codes: decoded.codes, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), verified: true, recordedAt: new Date().toISOString() };
  if (previous) {
    const historyFile = "web/fixtures/attribution-history.json";
    const history = existsSync(historyFile) ? JSON.parse(await readFile(historyFile, "utf8")) : [];
    if (!history.some((item: { transactionHash: string }) => item.transactionHash === previous.transactionHash)) history.push(previous);
    await writeFile(historyFile, JSON.stringify(history, null, 2));
  }
  await writeFile(proofFile, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
