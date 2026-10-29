import { describe, expect, it } from "vitest";
import { buildRoster, claudeGrader, claudeSkill } from "../../src/skills/claude.js";
import type { Task, TaskKind } from "../../src/arena/types.js";

type Call = { model: string; system?: string; content: string };

function fakeClient(reply: string, calls: Call[] = []) {
  return {
    messages: {
      create: async (args: { model: string; system?: string; messages: { content: string }[] }) => {
        calls.push({ model: args.model, system: args.system, content: args.messages[0]!.content });
        return { content: [{ type: "text", text: reply }] };
      },
    },
  } as never;
}

const task: Task = { kind: "summarize", input: "Revenue grew faster than planned across every region this quarter." };

describe("claude skill", () => {
  it("sends the task input to the chosen model and returns the text reply", async () => {
    const calls: Call[] = [];
    const skill = claudeSkill("summarize", { client: fakeClient("Revenue beat plan.", calls), model: "claude-haiku-5-5" });

    expect(skill.kind).toBe("summarize");
    expect(await skill.run(task)).toBe("Revenue beat plan.");
    expect(calls).toEqual([{ model: "claude-haiku-5-5", system: expect.stringMatching(/summar/i), content: task.input }]);
  });
});

describe("claude grader", () => {
  const grade = (reply: string) => claudeGrader({ client: fakeClient(reply), model: "claude-haiku-5-5" })(task, "an output");

  it("parses a score from the reply", async () => {
    expect(await grade("0.8")).toBe(0.8);
    expect(await grade("Score: 0.35")).toBe(0.35);
  });

  it("clamps out-of-range scores and treats an unparsable reply as 0", async () => {
    expect(await grade("7")).toBe(1);
    expect(await grade("-2")).toBe(0);
    expect(await grade("great!")).toBe(0);
  });
});

describe("seller roster", () => {
  const kinds: TaskKind[] = ["translate", "summarize", "extract"];
  const sample = (kind: TaskKind): Task => ({ kind, input: "word ".repeat(120) });
  const cents = (price: string) => Math.round(Number(price) * 100);

  it("falls back to stub mode without an API key", () => {
    expect(buildRoster({}).mode).toBe("stub");
    expect(buildRoster({ ANTHROPIC_API_KEY: "sk-test" }).mode).toBe("claude");
  });

  it("has at least three distinct sellers per kind with cent-sized prices and different speeds", () => {
    const { roster } = buildRoster({});
    expect(new Set(roster.map((r) => r.name)).size).toBe(roster.length);

    for (const kind of kinds) {
      const bidders = roster.filter((r) => r.skills.some((s) => s.kind === kind));
      expect(bidders.length).toBeGreaterThanOrEqual(3);
      expect(new Set(bidders.map((b) => b.etaMs)).size).toBeGreaterThan(1);
      for (const b of bidders) {
        const c = cents(b.priceUsd(sample(kind)));
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(10);
      }
    }
  });

  it("has a cent-sized digest for generalists, and two specialists that hire each other for it", () => {
    const { roster } = buildRoster({});
    const long: Task = { kind: "digest", input: "word ".repeat(120) };
    const byName = Object.fromEntries(roster.map((r) => [r.name, r]));
    const digestBidders = roster.filter((r) => r.skills.some((s) => s.kind === "digest") || r.hires);
    expect(digestBidders.length).toBeGreaterThanOrEqual(3);

    for (const name of ["Quill", "Marrow", "Vesper"]) {
      const entry = byName[name]!;
      expect(entry.skills.some((s) => s.kind === "digest")).toBe(true);
      const digest = cents(entry.priceUsd(long));
      expect(digest).toBeGreaterThan(cents(entry.priceUsd({ ...long, kind: "summarize" })) - 1);
      expect(digest).toBeLessThanOrEqual(10);
      expect(entry.etaFor?.(long)).toBeGreaterThan(entry.etaMs);
    }
    expect(byName.Quill!.etaFor?.(long)).toBeGreaterThan(byName.Quill!.etaMs);
    expect(cents(byName.Quill!.priceUsd(long))).toBeGreaterThan(cents(byName.Quill!.priceUsd({ ...long, kind: "summarize" })));

    expect(byName.Lex!.hires).toEqual({ kind: "digest", own: "translate", partner: "Gist" });
    expect(byName.Gist!.hires).toEqual({ kind: "digest", own: "summarize", partner: "Lex" });
    expect(byName.Lex!.skills.map((s) => s.kind)).toEqual(["translate"]);
  });

  it("gives the stub roster working skills and a grader", async () => {
    const { roster, grader } = buildRoster({});
    const entry = roster.find((r) => r.skills.some((s) => s.kind === "translate"))!;
    const output = await entry.skills.find((s) => s.kind === "translate")!.run(sample("translate"));

    expect(output.length).toBeGreaterThan(0);
    expect(await grader(sample("translate"), output)).toBeGreaterThan(0);
  });
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("live Claude smoke test", () => {
  it("summarizes with Haiku", async () => {
    const { roster, mode } = buildRoster(process.env);
    expect(mode).toBe("claude");
    const output = await roster[0]!.skills.find((s) => s.kind === "summarize")!.run(task);
    expect(output.length).toBeGreaterThan(0);
  });
});
