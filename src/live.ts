import { toHex } from "viem";
import { english, mnemonicToAccount } from "viem/accounts";

export const CELO_MAINNET = 42220;

// Mnemonics that are public by construction: the anvil/hardhat default (also used by
// remesso-sdk's dev environment) and the seller phrase in src/chain/env.ts. Any key derived
// from them can be spent by anyone, so none may ever sign on a real network.
const PUBLIC_MNEMONICS = [
  "test test test test test test test test test test test junk",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
];

/** Lower-case words with single spaces, so spacing and case cannot hide a public phrase. */
export const normalizeMnemonic = (phrase: string): string => phrase.trim().toLowerCase().split(/\s+/).join(" ");

function publicKeys(): Set<string> {
  const keys = new Set<string>();
  for (const phrase of PUBLIC_MNEMONICS) {
    for (let i = 0; i < 20; i++) {
      const key = mnemonicToAccount(phrase, { addressIndex: i }).getHdKey().privateKey;
      if (key) keys.add(toHex(key).toLowerCase());
    }
  }
  return keys;
}

const KEY_FORMAT = /^0x[0-9a-fA-F]{64}$/;

export type Preflight = { ok: true } | { ok: false; problems: string[] };

/**
 * Everything that must be true before this project signs a transaction on a real network.
 * It only inspects its inputs; it never sends anything.
 */
export function preflight(env: Record<string, string | undefined>, chainId: number): Preflight {
  const problems: string[] = [];
  const isPublic = publicKeys();

  if (env.OUTBID_LIVE !== "1") problems.push("set OUTBID_LIVE=1 to run against a real network");
  if (env.OUTBID_CONFIRM_SPEND !== "yes") problems.push("set OUTBID_CONFIRM_SPEND=yes to confirm that real money will be spent");
  if (chainId !== CELO_MAINNET) problems.push(`chain ${chainId} is not Celo mainnet (${CELO_MAINNET})`);

  const checkKey = (name: string, value: string | undefined, required: boolean) => {
    if (value === undefined || value === "") {
      if (required) problems.push(`${name} is required`);
      return;
    }
    if (!KEY_FORMAT.test(value)) problems.push(`${name} is not a 32-byte hex private key`);
    else if (isPublic.has(value.toLowerCase())) problems.push(`${name} is a public test key; anyone can spend from it`);
  };

  checkKey("OUTBID_OWNER_KEY", env.OUTBID_OWNER_KEY, true);
  checkKey("OUTBID_BUYER_KEY", env.OUTBID_BUYER_KEY, true);
  if (!env.OUTBID_SELLER_MNEMONIC) problems.push("OUTBID_SELLER_MNEMONIC is required (a fresh phrase that derives the seller keys)");
  else {
    const phrase = normalizeMnemonic(env.OUTBID_SELLER_MNEMONIC);
    const words = phrase.split(" ");
    if (![12, 24].includes(words.length) || !words.every((w) => english.includes(w))) {
      problems.push("OUTBID_SELLER_MNEMONIC is not a valid 12 or 24 word recovery phrase");
    } else if (PUBLIC_MNEMONICS.includes(phrase)) {
      problems.push("OUTBID_SELLER_MNEMONIC is a public test phrase; anyone can spend from it");
    }
  }

  if (env.OUTBID_OWNER_KEY && env.OUTBID_OWNER_KEY.toLowerCase() === env.OUTBID_BUYER_KEY?.toLowerCase()) {
    problems.push("OUTBID_OWNER_KEY and OUTBID_BUYER_KEY must differ: the agent cannot pay its own policy owner");
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
