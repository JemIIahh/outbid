import { describe, expect, it } from "vitest";
import { stubGrader, stubSkill } from "../../src/skills/skill.js";
import { DIGEST_PARTS, type Task } from "../../src/arena/types.js";

const task: Task = {
  kind: "summarize",
  input: "The committee reviewed the quarterly numbers and agreed that revenue growth was ahead of plan, ".repeat(4),
};

describe("stub skill and grader", () => {
  it("returns the same output for the same input", async () => {
    const skill = stubSkill("summarize");
    expect(await skill.run(task)).toBe(await skill.run(task));
  });

  it("grades full quality as 1 and half quality as about 0.5", async () => {
    const full = await stubSkill("summarize").run(task);
    const half = await stubSkill("summarize", { quality: 0.5 }).run(task);

    expect(await stubGrader(task, full)).toBe(1);
    expect(await stubGrader(task, half)).toBeCloseTo(0.5, 1);
  });

  it("grades empty output as 0", async () => {
    expect(await stubGrader(task, "")).toBe(0);
  });

  it("produces different output for different kinds", async () => {
    const a = await stubSkill("translate").run(task);
    const b = await stubSkill("extract").run(task);
    expect(a).not.toBe(b);
  });

  it("does a digest as the summary, translated", async () => {
    const summary = await stubSkill("summarize").run(task);
    const digest = await stubSkill("digest").run(task);

    expect(digest).toBe(await stubSkill("translate").run({ kind: "translate", input: summary }));
    expect(await stubGrader({ ...task, kind: "digest" }, digest)).toBe(1);
  });

  it("names the two halves of a digest in order", () => {
    expect(DIGEST_PARTS).toEqual(["summarize", "translate"]);
  });
});
