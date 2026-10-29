import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkProofStart, PROOF_JOBS } from "../../src/chain/proof.js";

const ready = () => ({
  OUTBID_LIVE: "1",
  OUTBID_CONFIRM_SPEND: "yes",
  OUTBID_OWNER_KEY: generatePrivateKey(),
  OUTBID_BUYER_KEY: generatePrivateKey(),
  OUTBID_SELLER_MNEMONIC: generateMnemonic(english),
  ANTHROPIC_API_KEY: "sk-ant-test",
});
const problems = (env: Record<string, string | undefined>, exists = false) => {
  const result = checkProofStart(env, exists);
  return result.ok ? [] : result.problems;
};

describe("the real-money proof run", () => {
  it("is three small jobs, none above the 0.10 that delivers on inclusion", () => {
    expect(PROOF_JOBS.map((j) => j.kind)).toEqual(["summarize", "translate", "digest"]);
    expect(PROOF_JOBS.every((j) => Number(j.budget) <= 0.1)).toBe(true);
  });

  it("starts when spending is confirmed, keys are private and real agents are available", () => {
    expect(problems(ready())).toEqual([]);
  });

  it("will not run with stand-in agents: placeholder work proves nothing", () => {
    expect(problems({ ...ready(), ANTHROPIC_API_KEY: undefined }).join("\n")).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("will not spend twice by accident: a recorded proof needs an explicit go-ahead to be replaced", () => {
    expect(problems(ready(), true).join("\n")).toMatch(/OUTBID_PROOF_AGAIN/);
    expect(problems({ ...ready(), OUTBID_PROOF_AGAIN: "1" }, true)).toEqual([]);
  });

  it("carries the mainnet preflight problems with it", () => {
    expect(problems({ ...ready(), OUTBID_CONFIRM_SPEND: undefined }).join("\n")).toMatch(/OUTBID_CONFIRM_SPEND/);
  });
});
