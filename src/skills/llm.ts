import Anthropic from "@anthropic-ai/sdk";

/** One question to a language model, answered in text. */
export type Chat = (o: { model: string; system: string; content: string; maxTokens: number }) => Promise<string>;

export type Llm = { chat: Chat; provider: "0g" | "anthropic"; fast: string; strong: string };

export const ZEROG_ROUTER_URL = "https://router-api.0g.ai/v1";

const ROUTER_TIMEOUT_MS = 30_000;
const MAX_ERROR = 160;

export function anthropicChat(client: Pick<Anthropic, "messages">): Chat {
  return async ({ model, system, content, maxTokens }) => {
    const reply = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] });
    return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  };
}

/** The 0G Compute Router speaks the OpenAI chat-completions format, so plain fetch is enough. */
export function routerChat(o: { apiKey: string; baseUrl?: string; timeoutMs?: number }): Chat {
  const base = new URL(o.baseUrl ?? ZEROG_ROUTER_URL);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !local) throw new Error("the router address must be https, or the key would travel in the clear");
  const url = `${base.href.replace(/\/$/, "")}/chat/completions`;

  return async ({ model, system, content, maxTokens }) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content }] }),
        signal: AbortSignal.timeout(o.timeoutMs ?? ROUTER_TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new Error(timedOut ? "the router did not answer in time" : "the router could not be reached", { cause });
    }

    const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown }; choices?: { message?: { content?: unknown } }[] };
    if (!res.ok) {
      const why = typeof body.error?.message === "string" ? body.error.message : "no reason given";
      throw new Error(`the router answered ${res.status}: ${why.slice(0, MAX_ERROR)}`);
    }
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") throw new Error("the router's reply had no text");
    return text;
  };
}

/** The 0G Router when ZEROG_API_KEY is set, else Anthropic when ANTHROPIC_API_KEY is, else nothing. */
export function llmFromEnv(env: NodeJS.ProcessEnv): Llm | undefined {
  const zerog = env.ZEROG_API_KEY?.trim();
  if (zerog) {
    const baseUrl = env.ZEROG_BASE_URL?.trim() || undefined;
    return {
      provider: "0g",
      chat: routerChat({ apiKey: zerog, ...(baseUrl ? { baseUrl } : {}) }),
      fast: env.OUTBID_FAST_MODEL?.trim() || "claude-sonnet-5",
      strong: env.OUTBID_STRONG_MODEL?.trim() || "claude-sonnet-5",
    };
  }
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return { provider: "anthropic", chat: anthropicChat(new Anthropic({ apiKey: anthropic })), fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" };
  return undefined;
}
