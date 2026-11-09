import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getTokenBalance, x402 } from "@celo/buy-core";
import { privateKeyToAccount } from "viem/accounts";
import type { Chat } from "./llm.js";

export const BUY_CATALOG = "https://gateway.usebuy.ai/v1/catalog";
export const BUY_INFERENCE = "https://gateway.usebuy.ai/cencori/v1/chat/completions";
export const BUY_MODEL = "maximo-atlas-1.3";
export const BUY_CALL_MAX = 10_000n; // 0.01 USDT; never raise this from a server response.
export function buyToken(env: Record<string, string | undefined>) {
  const symbol = env.OUTBID_BUY_TOKEN ?? "USDT";
  if (symbol !== "USDT" && symbol !== "USDC") throw new Error("OUTBID_BUY_TOKEN must be USDT or USDC");
  return { symbol, address: symbol === "USDC" ? "0xceba9300f2b948710d2653dd7b07f33a8b32118c" : "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", feeCurrency: symbol === "USDC" ? "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B" as const : "0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72" as const };
}

export function inferenceBody(o: Parameters<Chat>[0]): string {
  return JSON.stringify({ model: BUY_MODEL, max_tokens: 1024, messages: [
    { role: "system", content: o.system }, { role: "user", content: o.content },
  ] });
}

/** Free discovery and an exact, unsigned quote. Never loads a signer. */
export async function quoteInference(body: string, fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = {}) {
  const token = buyToken(env);
  const catalogResponse = await fetchImpl(BUY_CATALOG, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!catalogResponse.ok) throw new Error("buy catalog unavailable");
  const catalog = await catalogResponse.json() as { capabilities?: { url: string; available: boolean; method: string }[] };
  if (!catalog.capabilities?.some(c => c.url === BUY_INFERENCE && c.available && c.method === "POST")) throw new Error("buy inference is not available in the live catalog");
  const response = await fetchImpl(BUY_INFERENCE, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000), redirect: "error" });
  const text = await response.text();
  const envelope = x402.parseV2Header(response.headers.get("payment-required"), BUY_INFERENCE) ?? x402.parseEnvelope(text);
  if (response.status !== 402 || !envelope) throw new Error(`buy did not provide a payment quote (HTTP ${response.status})`);
  const offer = x402.selectRequirements(envelope, "celo", token.symbol);
  if (!offer || offer.network !== "celo" || offer.asset.toLowerCase() !== token.address || offer.scheme !== "exact" || BigInt(offer.maxAmountRequired) > BUY_CALL_MAX) throw new Error(`buy quote is outside the approved Celo ${token.symbol} limit`);
  return { capability: "cencori/inference", url: BUY_INFERENCE, token: token.symbol, amountAtomic: offer.maxAmountRequired, payTo: offer.payTo, body, bodySha256: createHash("sha256").update(body).digest("hex") };
}

/** One paid attempt per invocation. Durable intent survives an interrupted payment. */
export function buyChat(env: NodeJS.ProcessEnv): Chat {
  const token = buyToken(env);
  const maxCalls = Number(env.OUTBID_BUY_MAX_CALLS ?? "5");
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10) throw new Error("OUTBID_BUY_MAX_CALLS must be 1–10");
  let reserved = 0;
  let stopped = false;
  return async (o) => {
    if (env.OUTBID_BUY_CONFIRM_SPEND !== "yes") throw new Error("Set OUTBID_BUY_CONFIRM_SPEND=yes to authorize buy USDT payments");
    if (stopped || reserved >= maxCalls) throw new Error("buy spending limit reached or a previous paid request needs review");
    // Reserve synchronously so concurrent sellers cannot race past the limit.
    reserved++;
    const body = inferenceBody(o);
    const quote = await quoteInference(body, fetch, env);
    if (!env.OUTBID_BUYER_KEY) throw new Error("OUTBID_BUYER_KEY is required for buy");
    const account = privateKeyToAccount(env.OUTBID_BUYER_KEY as `0x${string}`);
    const id = randomUUID();
    await mkdir("state/buy", { recursive: true });
    const record: Record<string, unknown> = { id, createdAt: new Date().toISOString(), payer: account.address, chainId: 42220, quote, status: "quoted" };
    const save = () => writeFile(`state/buy/${id}.json`, JSON.stringify(record, null, 2), { mode: 0o600 });
    await save();
    try {
      const response = await x402.payingFetch({ account, network: "celo", preferredToken: token.symbol, readBalance: getTokenBalance }, BUY_INFERENCE, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        maxAmount: BUY_CALL_MAX, maxRetries: 1, signal: AbortSignal.timeout(90_000), redirect: "error",
        onBeforePayment: async (offer) => {
          if (offer.payTo.toLowerCase() !== quote.payTo.toLowerCase() || offer.asset.toLowerCase() !== token.address || offer.maxAmountRequired !== quote.amountAtomic || offer.scheme !== "exact") throw new Error("buy quote changed; refusing to sign a different payment");
          record.status = "payment-submitted";
          await save();
        },
        onPayment: async (receipt) => { record.receipt = receipt; await save(); },
        onAccountingError: () => { stopped = true; console.error(`buy receipt could not be saved; inspect request ${id} before another purchase`); },
      });
      const raw = await response.text();
      record.response = { status: response.status, body: raw, correlationId: response.headers.get("x-correlation-id") };
      record.status = response.ok ? "delivered" : "needs-review";
      await save();
      if (!response.ok) throw new Error(`buy HTTP ${response.status}; inspect state/buy/${id}.json; do not retry automatically`);
      const parsed = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] };
      const output = parsed.choices?.[0]?.message?.content;
      if (typeof output !== "string" || !output.trim()) throw new Error("buy inference returned no text");
      console.log(`buy inference receipt: state/buy/${id}.json`);
      return output;
    } catch (error) {
      stopped = true;
      record.status = "needs-review";
      await save();
      throw error;
    }
  };
}
