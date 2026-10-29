import Anthropic from "@anthropic-ai/sdk";
import { DIGEST_PARTS, type Task, type TaskKind } from "../arena/types.js";
import { stubGrader, stubSkill, type Grader, type Skill } from "./skill.js";

type Client = Pick<Anthropic, "messages">;

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

const INSTRUCTIONS: Record<TaskKind, string> = {
  translate: "Translate the user's text into French. Reply with the translation only.",
  summarize: "Summarize the user's text in one or two sentences. Reply with the summary only.",
  extract: "Extract the key facts from the user's text as a short comma-separated list. Reply with the list only.",
  digest: "Summarize the user's text in one or two sentences, then translate that summary into French. Reply with the French summary only.",
};

const GRADING =
  "You grade work. Given a task and an output, reply with only a number from 0 (useless) to 1 (excellent) for how well the output does the task.";

async function ask(client: Client, model: string, system: string, content: string, maxTokens: number): Promise<string> {
  const reply = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] });
  return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function claudeSkill(kind: TaskKind, o: { client: Client; model: string }): Skill {
  return { kind, run: (task) => ask(o.client, o.model, INSTRUCTIONS[kind], task.input, 400) };
}

export function claudeGrader(o: { client: Client; model: string }): Grader {
  return async (task, output) => {
    const reply = await ask(o.client, o.model, GRADING, `Task (${task.kind}):\n${task.input}\n\nOutput:\n${output}`, 10);
    const score = Number.parseFloat(reply.match(/-?\d+(?:\.\d+)?/)?.[0] ?? "");
    return Number.isNaN(score) ? 0 : Math.min(1, Math.max(0, score));
  };
}

export type RosterEntry = {
  name: string;
  skills: Skill[];
  priceUsd: (task: Task) => string;
  etaMs: number;
  etaFor?: (task: Task) => number;
  /** Takes a digest by doing `own` itself and hiring the roster entry called `partner` for the rest. */
  hires?: { kind: "digest"; own: (typeof DIGEST_PARTS)[number]; partner: string };
};

type Profile = {
  name: string;
  kinds: TaskKind[];
  cents: number;
  etaMs: number;
  quality: number;
  model: string;
  hires?: RosterEntry["hires"];
};

const ALL: TaskKind[] = ["translate", "summarize", "extract"];
// A generalist does a digest in one go, for half as much again as a single job and a bit slower.
const DIGEST_PRICE_FACTOR = 1.5;
const DIGEST_ETA_FACTOR = 1.5;

// Three generalists plus two specialists, so every kind has at least three bidders. Each trades
// price against speed and quality (cheap is slow and weak, dear is fast and strong); a roster
// where one seller is cheapest AND fastest would win every auction.
const PROFILES: Profile[] = [
  { name: "Quill", kinds: [...ALL, "digest"], cents: 2, etaMs: 4000, quality: 0.6, model: HAIKU },
  { name: "Marrow", kinds: [...ALL, "digest"], cents: 5, etaMs: 2500, quality: 0.8, model: HAIKU },
  { name: "Vesper", kinds: [...ALL, "digest"], cents: 9, etaMs: 1200, quality: 1, model: SONNET },
  // The specialists take a digest between them: each does its half and hires the other for the rest.
  { name: "Lex", kinds: ["translate"], cents: 3, etaMs: 2000, quality: 0.95, model: SONNET, hires: { kind: "digest", own: "translate", partner: "Gist" } },
  { name: "Gist", kinds: ["summarize"], cents: 3, etaMs: 2200, quality: 0.95, model: SONNET, hires: { kind: "digest", own: "summarize", partner: "Lex" } },
];

/** Long inputs cost a cent more. Never above 0.10, so every job delivers on `included`. */
const price = (cents: number, task: Task) => (Math.min(10, cents + (task.input.length > 400 ? 1 : 0)) / 100).toFixed(2);

export function buildRoster(env: NodeJS.ProcessEnv): { roster: RosterEntry[]; grader: Grader; mode: "claude" | "stub" } {
  const apiKey = env.ANTHROPIC_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey }) : undefined;

  const roster: RosterEntry[] = PROFILES.map((p) => ({
    name: p.name,
    skills: p.kinds.map((kind) => (client ? claudeSkill(kind, { client, model: p.model }) : stubSkill(kind, { quality: p.quality }))),
    priceUsd: (task: Task) => price(task.kind === "digest" ? Math.ceil(p.cents * DIGEST_PRICE_FACTOR) : p.cents, task),
    etaMs: p.etaMs,
    etaFor: (task: Task) => (task.kind === "digest" ? Math.round(p.etaMs * DIGEST_ETA_FACTOR) : p.etaMs),
    ...(p.hires ? { hires: p.hires } : {}),
  }));

  return client
    ? { roster, grader: claudeGrader({ client, model: HAIKU }), mode: "claude" }
    : { roster, grader: stubGrader, mode: "stub" };
}
