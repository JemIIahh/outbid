import { describe, expect, it, vi } from "vitest";
import { buyChat, buyToken, BUY_INFERENCE, inferenceBody, quoteInference } from "../../src/skills/buy.js";
import { builderCodes, attributionSuffix } from "../../src/chain/attribution.js";
import { fromDataSuffix } from "@celo/attribution-tags";
import { llmFromEnv } from "../../src/skills/llm.js";

const request = { model: "unused", system: "Summarize.", content: "Customer feedback", maxTokens: 400 };
const offer = { scheme: "exact", network: "celo", asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", maxAmountRequired: "10000", payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B", resource: BUY_INFERENCE, description: "inference", mimeType: "application/json", maxTimeoutSeconds: 60 };
function server(overrides = {}) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: [{ url: BUY_INFERENCE, method: "POST", available: true }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ x402Version: 1, accepts: [{ ...offer, ...overrides }], error: "Payment Required" }), { status: 402 }));
}
describe("buy inference", () => {
  it("quotes USDC when selected and uses its fee adapter", async () => {
    const token = buyToken({ OUTBID_BUY_TOKEN: "USDC" });
    const quote = await quoteInference(inferenceBody(request), server({ asset: token.address }), { OUTBID_BUY_TOKEN: "USDC" });
    expect(quote.token).toBe("USDC");
    expect(token.feeCurrency).toBe("0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B");
    expect(() => buyToken({ OUTBID_BUY_TOKEN: "BAD" })).toThrow();
  });
  it("selects paid buy inference without an upstream API key", () => {
    expect(llmFromEnv({ OUTBID_LLM_PROVIDER: "buy" })).toMatchObject({ provider: "buy", fast: "maximo-atlas-1.3", strong: "maximo-atlas-1.3" });
  });
  it("quotes the exact task without signing or modifying its body", async () => {
    const fetchImpl = server();
    const body = inferenceBody(request);
    const quote = await quoteInference(body, fetchImpl);
    expect(quote).toMatchObject({ token: "USDT", amountAtomic: "10000", body });
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(body);
    expect(body).toContain('"max_tokens":1024');
  });
  it.each([{ maxAmountRequired: "10001" }, { network: "base" }, { asset: "0x0000000000000000000000000000000000000001" }, { scheme: "upto" }])("refuses an unapproved offer: %j", async change => {
    await expect(quoteInference(inferenceBody(request), server(change))).rejects.toThrow(/approved/);
  });
  it("refuses payment before network access unless explicitly authorized", async () => {
    await expect(buyChat({})(request)).rejects.toThrow(/CONFIRM_SPEND/);
    expect(() => buyChat({ OUTBID_BUY_MAX_CALLS: "11" })).toThrow(/1–10/);
  });
  it("carries the assigned code alongside the repository code", () => {
    expect(builderCodes({ OUTBID_ATTRIBUTION_CODE: "celo_assigned" })).toEqual(["celo_assigned", "celo_66c20e3501f3"]);
    expect(fromDataSuffix(attributionSuffix({ OUTBID_ATTRIBUTION_CODE: "celo_assigned" }))?.codes).toContain("celo_assigned");
    expect(() => builderCodes({ OUTBID_ATTRIBUTION_CODE: "BAD CODE" })).toThrow();
  });
});
