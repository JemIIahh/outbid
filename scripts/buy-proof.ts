import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { celo } from "viem/chains";
import { claudeSkill } from "../src/skills/claude.js";
import { buyChat, BUY_MODEL, inferenceBody, quoteInference } from "../src/skills/buy.js";

const task = { kind: "summarize" as const, input: "Customers praised the new checkout flow, but several reported that confirmation emails arrived late and refunds took longer than the promised three days. The operations team needs a concise summary before its weekly meeting." };
const request = { model: BUY_MODEL, maxTokens: 400, system: "Summarize the user's text in one or two sentences. Reply with the summary only.", content: task.input };
const quote = await quoteInference(inferenceBody(request));
if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ ...quote, purpose: "Outbid seller summarizes customer feedback using paid Cencori inference", execute: "pnpm buy:proof --execute" }, null, 2));
} else {
  if (existsSync("web/fixtures/buy-proof.json")) throw new Error("A buy proof already exists; inspect it before authorizing another purchase");
  const before = new Set(await readdir("state/buy").catch(() => [] as string[]));
  for (const file of before) {
    const previous = JSON.parse(await readFile(`state/buy/${file}`, "utf8"));
    if (previous.quote?.bodySha256 === quote.bodySha256) throw new Error(`An attempt for this task already exists in state/buy/${file}; inspect it before any new purchase`);
  }
  const output = await claudeSkill("summarize", { model: BUY_MODEL, chat: buyChat({ ...process.env, OUTBID_BUY_MAX_CALLS: "1" }) }).run(task);
  const files = (await readdir("state/buy")).filter(file => !before.has(file));
  const records = await Promise.all(files.map(async file => JSON.parse(await readFile(`state/buy/${file}`, "utf8"))));
  const record = records.find(r => r.status === "delivered");
  if (!record?.receipt?.txHash || record.receipt.outcome !== "confirmed") throw new Error("Inference delivered without a confirmed settlement hash; inspect state/buy before another purchase");
  const pub = createPublicClient({ chain: celo, transport: http(process.env.OUTBID_RPC_URL) });
  if (await pub.getChainId() !== 42220) throw new Error("Payment verification requires Celo mainnet");
  const settlement = await pub.waitForTransactionReceipt({ hash: record.receipt.txHash, timeout: 90_000 });
  const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const paid = settlement.logs.some(log => {
    if (log.address.toLowerCase() !== "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e") return false;
    try {
      const transfer = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      return transfer.args.from.toLowerCase() === record.payer.toLowerCase() && transfer.args.to.toLowerCase() === record.quote.payTo.toLowerCase() && transfer.args.value === BigInt(record.quote.amountAtomic);
    } catch { return false; }
  });
  if (settlement.status !== "success" || !paid) throw new Error("Settlement receipt does not prove the quoted USDT transfer; inspect state/buy before any new purchase");
  await mkdir("web/fixtures", { recursive: true });
  await writeFile("web/fixtures/buy-proof.json", JSON.stringify({ ...record, recordedAt: new Date().toISOString(), chainId: 42220, task, output, settlementVerified: true, settlementBlock: settlement.blockNumber.toString() }, null, 2));
  console.log(output);
  console.log(`Payment: https://celoscan.io/tx/${record.receipt.txHash}`);
}
