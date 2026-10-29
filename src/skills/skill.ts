import type { Task, TaskKind } from "../arena/types.js";

export interface Skill {
  kind: TaskKind;
  run(task: Task): Promise<string>;
}

/** Scores a delivery from 0 (useless) to 1 (as good as it gets). */
export type Grader = (task: Task, output: string) => Promise<number>;

function fullOutput(task: Task): string {
  switch (task.kind) {
    case "translate":
      return `[translated] ${task.input.toUpperCase()}`;
    case "summarize":
      return `[summary] ${task.input.slice(0, Math.ceil(task.input.length / 3))}`;
    case "extract":
      return `[extract] ${task.input.split(/\s+/).filter((w) => w.length > 5).join(", ")}`;
    case "digest":
      return fullOutput({ kind: "translate", input: fullOutput({ kind: "summarize", input: task.input }) });
  }
}

/** Deterministic stand-in for a model. `quality` keeps that share of the full output. */
export function stubSkill(kind: TaskKind, opts: { quality?: number } = {}): Skill {
  const quality = Math.min(1, Math.max(0, opts.quality ?? 1));
  return {
    kind,
    async run(task) {
      const full = fullOutput({ ...task, kind });
      return full.slice(0, Math.ceil(full.length * quality));
    },
  };
}

export const stubGrader: Grader = async (task, output) => {
  const full = fullOutput(task);
  if (output.length === 0 || full.length === 0) return 0;
  return Math.min(1, output.length / full.length);
};
