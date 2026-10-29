// Creates the keys for a real-money run and appends them to .env (git-ignored), never over an
// existing value. It prints addresses only; the secrets stay in the file. Sends nothing.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";

const ENV_FILE = ".env";
const current = await readFile(ENV_FILE, "utf8").catch(() => "");
const isSet = (name: string) => new RegExp(`^${name}=\\S`, "m").test(current);

const made: Record<string, string> = {};
if (!isSet("OUTBID_OWNER_KEY")) made.OUTBID_OWNER_KEY = generatePrivateKey();
if (!isSet("OUTBID_BUYER_KEY")) made.OUTBID_BUYER_KEY = generatePrivateKey();
if (!isSet("OUTBID_SELLER_MNEMONIC")) made.OUTBID_SELLER_MNEMONIC = `"${generateMnemonic(english)}"`;

if (Object.keys(made).length === 0) {
  console.log(".env already has all three. Nothing changed. Run: pnpm funding");
} else {
  if (!current) await writeFile(ENV_FILE, "", { mode: 0o600 });
  const lead = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(ENV_FILE, `${lead}${Object.entries(made).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  console.log(`Added to .env: ${Object.keys(made).join(", ")} (secrets are not printed).`);
  console.log("Next: pnpm funding   (shows which addresses to fund, and how much)");
}
