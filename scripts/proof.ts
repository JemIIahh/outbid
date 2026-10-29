// The real-money run: three small auctions on Celo mainnet with Claude agents, one of them a job
// where the winner hires another agent. It writes every transaction hash to web/fixtures/proof.json.
// It spends real USDT, so it refuses unless the owner confirmed in .env (see checkProofStart).
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { startMainnet } from "../src/chain/mainnet.js";
import { checkProofStart, PROOF_FILE, runProof, spendLines } from "../src/chain/proof.js";
import { CELO_MAINNET } from "../src/live.js";

const guard = checkProofStart(process.env, existsSync(PROOF_FILE));
if (!guard.ok) {
  console.error(`Not running:\n- ${guard.problems.join("\n- ")}`);
  process.exit(1);
}

const app = await createApp(process.env, { finalityPollMs: 15_000 }, (roster) => startMainnet(process.env, roster));
let failed: string | undefined;
try {
  const result = await runProof(app);
  failed = result.failed;

  const state = await app.state();
  const policies = (app.env.policies ?? []).map((p) => ({ label: p.label, id: p.id.toString() }));
  const record = JSON.stringify({ recordedAt: new Date().toISOString(), chainId: CELO_MAINNET, mode: app.mode, policies, state, events: result.events }, null, 1);

  // A run that stopped early is kept for the owner, but never under the name the page shows as proof.
  const file = failed ? "state/proof-failed.json" : PROOF_FILE;
  if (failed) await mkdir("state", { recursive: true });
  await writeFile(file, record);

  console.log(failed ? `\nSTOPPED: ${failed}` : "\nDone.");
  console.log("Real payments made:");
  for (const line of spendLines(result.events)) console.log(`  ${line}`);
  console.log(`Policies created: ${policies.map((p) => `${p.label} ${p.id}`).join(", ")}`);
  console.log(failed ? `Everything that happened is in ${file}.` : `Saved ${PROOF_FILE}. Open the page with ?proof to see it.`);
} catch (error) {
  // Something other than a failed auction went wrong: still show what was already paid.
  console.error(`\nSTOPPED: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Real payments made before it stopped:");
  for (const line of spendLines(app.bus.history())) console.error(`  ${line}`);
  process.exitCode = 1;
} finally {
  // Revokes every policy this run created, so nothing keeps spending authority.
  await app.close().catch((error: unknown) => console.error(`Could not close cleanly: ${error instanceof Error ? error.message : String(error)}`));
}
if (failed) process.exitCode = 1;
