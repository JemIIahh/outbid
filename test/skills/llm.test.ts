import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { llmFromEnv, routerChat, ZEROG_ROUTER_URL } from "../../src/skills/llm.js";

type Seen = { method?: string; url?: string; auth?: string; body: Record<string, unknown> };

let server: http.Server | undefined;

/** A stand-in for the router that answers in the OpenAI chat-completions format. */
async function router(reply: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
      seen.push(entry);
      const { status, body } = reply(entry);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const ask = { model: "claude-sonnet-5", system: "Be brief.", content: "Hello", maxTokens: 50 };

describe("router chat", () => {
  it("posts a chat completion with the key and returns the reply text", async () => {
    const { seen, baseUrl } = await router(() => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "Hi there." } }] } }));

    const text = await routerChat({ apiKey: "key-123", baseUrl })(ask);

    expect(text).toBe("Hi there.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      auth: "Bearer key-123",
      body: { model: "claude-sonnet-5", max_tokens: 50, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello" }] },
    });
  });

  it("fails with the router's message and the status, never with the key", async () => {
    const { baseUrl } = await router(() => ({ status: 402, body: { error: { message: "balance too low to serve this request" } } }));

    const attempt = routerChat({ apiKey: "key-SECRET", baseUrl })(ask);

    await expect(attempt).rejects.toThrow(/402.*balance too low/);
    await expect(attempt).rejects.not.toThrow(/key-SECRET/);
  });

  it("fails on a reply with no text, instead of returning an empty answer", async () => {
    const { baseUrl } = await router(() => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: null } }] } }));
    await expect(routerChat({ apiKey: "k", baseUrl })(ask)).rejects.toThrow(/no text/);
  });

  it("gives up on a router that does not answer", async () => {
    server = http.createServer(() => {});
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    await expect(routerChat({ apiKey: "k", baseUrl, timeoutMs: 100 })(ask)).rejects.toThrow(/did not answer|timed out/i);
  });

  it("will not send the key over plain http to another machine", () => {
    expect(() => routerChat({ apiKey: "k", baseUrl: "http://router.example.com/v1" })).toThrow(/https/);
    expect(() => routerChat({ apiKey: "k", baseUrl: "http://127.0.0.1:9/v1" })).not.toThrow();
    expect(() => routerChat({ apiKey: "k", baseUrl: "https://router.example.com/v1" })).not.toThrow();
  });
});

describe("choosing a provider from the environment", () => {
  it("uses nothing without a key", () => {
    expect(llmFromEnv({})).toBeUndefined();
    expect(llmFromEnv({ ZEROG_API_KEY: "  ", ANTHROPIC_API_KEY: "" })).toBeUndefined();
  });

  it("uses the 0G Router, on mainnet by default, when it has a key, even if an Anthropic key is also set", () => {
    const llm = llmFromEnv({ ZEROG_API_KEY: "k", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(llm).toMatchObject({ provider: "0g", fast: "claude-sonnet-5", strong: "claude-sonnet-5" });
    expect(ZEROG_ROUTER_URL).toBe("https://router-api.0g.ai/v1");
  });

  it("lets the models be chosen, and falls back to Anthropic with only its key", () => {
    expect(llmFromEnv({ ZEROG_API_KEY: "k", OUTBID_FAST_MODEL: "qwen3.7-flash", OUTBID_STRONG_MODEL: "claude-opus-5.5" })).toMatchObject({ fast: "qwen3.7-flash", strong: "claude-opus-5.5" });
    expect(llmFromEnv({ ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ provider: "anthropic", fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" });
  });
});
