import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { preflight } from "../src/live.js";

// The first well-known anvil/hardhat account: public, so never acceptable on a real network.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const good = () => ({
  OUTBID_LIVE: "1",
  OUTBID_CONFIRM_SPEND: "yes",
  OUTBID_OWNER_KEY: generatePrivateKey(),
  OUTBID_BUYER_KEY: generatePrivateKey(),
  OUTBID_SELLER_MNEMONIC: generateMnemonic(english),
});

describe("mainnet preflight", () => {
  it("accepts a fully confirmed setup on Celo mainnet", () => {
    expect(preflight(good(), 42220)).toEqual({ ok: true });
  });

  it("lists every missing confirmation", () => {
    const result = preflight({ OUTBID_OWNER_KEY: generatePrivateKey(), OUTBID_BUYER_KEY: generatePrivateKey() }, 42220);
    expect(result).toMatchObject({ ok: false });
    const problems = (result as { problems: string[] }).problems.join("\n");
    expect(problems).toMatch(/OUTBID_LIVE/);
    expect(problems).toMatch(/OUTBID_CONFIRM_SPEND/);
  });

  it("refuses any chain other than Celo mainnet", () => {
    expect(preflight(good(), 31337)).toMatchObject({ ok: false, problems: [expect.stringMatching(/chain/i)] });
  });

  it("refuses a public dev key as owner, buyer or seller", () => {
    for (const name of ["OUTBID_OWNER_KEY", "OUTBID_BUYER_KEY"]) {
      const result = preflight({ ...good(), [name]: DEV_KEY }, 42220);
      expect(result).toMatchObject({ ok: false });
      expect((result as { problems: string[] }).problems.join("\n")).toMatch(new RegExp(`${name}.*public`));
    }
  });

  it("needs a seller phrase that is valid and not one of the public test phrases", () => {
    const problems = (env: Record<string, string | undefined>) => (preflight(env, 42220) as { problems: string[] }).problems.join("\n");
    expect(problems({ ...good(), OUTBID_SELLER_MNEMONIC: undefined })).toMatch(/OUTBID_SELLER_MNEMONIC is required/);
    expect(problems({ ...good(), OUTBID_SELLER_MNEMONIC: "not a real phrase at all" })).toMatch(/OUTBID_SELLER_MNEMONIC is not a valid/);
    for (const phrase of [
      "test test test test test test test test test test test junk",
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    ]) {
      expect(problems({ ...good(), OUTBID_SELLER_MNEMONIC: phrase })).toMatch(/OUTBID_SELLER_MNEMONIC.*public/);
      // Spacing and case must not get a public phrase past the check.
      expect(problems({ ...good(), OUTBID_SELLER_MNEMONIC: `  ${phrase.toUpperCase().replace(/ /g, "  ")} ` })).toMatch(/public/);
    }
  });

  it("refuses missing, malformed or identical owner and buyer keys", () => {
    expect(preflight({ ...good(), OUTBID_OWNER_KEY: undefined }, 42220)).toMatchObject({ ok: false });
    expect(preflight({ ...good(), OUTBID_BUYER_KEY: "not-a-key" }, 42220)).toMatchObject({ ok: false });
    const same = generatePrivateKey();
    const result = preflight({ ...good(), OUTBID_OWNER_KEY: same, OUTBID_BUYER_KEY: same }, 42220);
    expect((result as { problems: string[] }).problems.join("\n")).toMatch(/must differ/);
  });
});
