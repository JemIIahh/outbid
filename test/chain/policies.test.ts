import { describe, expect, it } from "vitest";
import { createPolicies, type PolicyStep } from "../../src/chain/policies.js";

/** Records what was created and revoked, in order. */
function steps(failAt?: string, failRevoke?: string): { steps: PolicyStep[]; log: string[] } {
  const log: string[] = [];
  const make = (label: string, id: bigint): PolicyStep => ({
    label,
    create: async () => {
      if (label === failAt) throw new Error(`rpc hiccup creating ${label}`);
      log.push(`create ${label}`);
      return id;
    },
    revoke: async () => {
      if (label === failRevoke) throw new Error("no gas");
      log.push(`revoke ${label}`);
    },
  });
  return { steps: [make("buyer", 7n), make("Lex", 8n), make("Gist", 9n)], log };
}

describe("creating spending policies on a real network", () => {
  it("returns every id so they can be recorded", async () => {
    const { steps: s } = steps();
    const made = await createPolicies(s);
    expect(made.policies).toEqual([{ label: "buyer", id: 7n }, { label: "Lex", id: 8n }, { label: "Gist", id: 9n }]);
  });

  it("revokes whatever it already created, newest first, when a later one fails, and says so", async () => {
    const { steps: s, log } = steps("Gist");

    const error = await createPolicies(s).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Gist/);
    expect((error as Error).message).toMatch(/rpc hiccup/);
    expect((error as Error).message).toMatch(/revoked.*Lex.*buyer/i);
    expect(log).toEqual(["create buyer", "create Lex", "revoke Lex", "revoke buyer"]);
  });

  it("names a policy it could not revoke instead of hiding the original failure", async () => {
    const { steps: s } = steps("Gist", "Lex");

    const error = (await createPolicies(s).catch((e: Error) => e)) as Error;

    expect(error.message).toMatch(/rpc hiccup/);
    expect(error.message).toMatch(/could not revoke.*Lex.*8/i);
  });

  it("revokes all of them when asked, reporting the ones that would not revoke", async () => {
    const { steps: s, log } = steps(undefined, "Lex");
    const made = await createPolicies(s);

    const failed = await made.revokeAll();

    expect(log.filter((l) => l.startsWith("revoke"))).toEqual(["revoke Gist", "revoke buyer"]);
    expect(failed).toEqual(["Lex (policy 8)"]);
  });
});
