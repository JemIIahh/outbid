export type PolicyStep = {
  label: string;
  create(): Promise<bigint>;
  revoke(id: bigint): Promise<unknown>;
};

export type MadePolicies = {
  policies: { label: string; id: bigint }[];
  /** Revokes every policy, newest first. Returns the ones that would not revoke; never throws. */
  revokeAll(): Promise<string[]>;
};

const describe = (p: { label: string; id: bigint }) => `${p.label} (policy ${p.id})`;

/**
 * Create spending policies one after another on a real network. If one fails, the ones already
 * created are revoked, so a half-finished start does not leave live policies behind, and the error
 * names anything that could not be revoked.
 */
export async function createPolicies(steps: PolicyStep[]): Promise<MadePolicies> {
  const made: { label: string; id: bigint; step: PolicyStep }[] = [];

  const revokeAll = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const policy of [...made].reverse()) {
      try {
        await policy.step.revoke(policy.id);
      } catch {
        failed.push(describe(policy));
      }
    }
    return failed;
  };

  for (const step of steps) {
    try {
      made.push({ label: step.label, id: await step.create(), step });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const created = [...made].reverse().map((p) => p.label);
      const failed = await revokeAll();
      const undone = created.length ? ` Revoked: ${created.filter((l) => !failed.some((f) => f.startsWith(`${l} `))).join(", ") || "none"}.` : "";
      const stuck = failed.length ? ` Could not revoke: ${failed.join(", ")}; revoke these yourself.` : "";
      throw new Error(`creating the ${step.label} policy failed: ${reason}.${undone}${stuck}`, { cause });
    }
  }

  return { policies: made.map(({ label, id }) => ({ label, id })), revokeAll };
}
