import http from "node:http";
import type { AddressInfo } from "node:net";
import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { startMainnet } from "../../src/chain/mainnet.js";

// A fake RPC node that records every method it is asked. Nothing here is a real network.
let server: http.Server | undefined;
let methods: string[] = [];

async function fakeNode(chainId: string): Promise<string> {
  methods = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const calls = [JSON.parse(body)].flat() as { id: number; method: string }[];
      methods.push(...calls.map((c) => c.method));
      // Every contract read (a USDT balance) answers zero.
      const zero = `0x${"00".repeat(32)}`;
      const answers = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_chainId" ? chainId : c.method === "eth_call" ? zero : "0x0" }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? answers : answers[0]));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const confirmed = () => ({
  OUTBID_LIVE: "1",
  OUTBID_CONFIRM_SPEND: "yes",
  OUTBID_OWNER_KEY: generatePrivateKey(),
  OUTBID_BUYER_KEY: generatePrivateKey(),
  OUTBID_SELLER_MNEMONIC: generateMnemonic(english),
});
const roster = { sellerNames: ["Quill", "Lex", "Gist"], hirers: ["Lex", "Gist"] };

describe("starting on mainnet", () => {
  it("refuses, before touching the network, unless real spending was confirmed", async () => {
    const rpcUrl = await fakeNode("0xa4ec");
    const { OUTBID_CONFIRM_SPEND: _omitted, ...unconfirmed } = confirmed();

    await expect(startMainnet(unconfirmed, { ...roster, rpcUrl })).rejects.toThrow(/OUTBID_CONFIRM_SPEND/);

    expect(methods).toEqual([]);
  });

  it("refuses a public seller phrase before touching the network", async () => {
    const rpcUrl = await fakeNode("0xa4ec");
    const env = { ...confirmed(), OUTBID_SELLER_MNEMONIC: "legal winner thank year wave sausage worth useful legal winner thank yellow" };

    await expect(startMainnet(env, { ...roster, rpcUrl })).rejects.toThrow(/public/);

    expect(methods).toEqual([]);
  });

  it("refuses a node that is not Celo mainnet, having asked only which chain it is", async () => {
    const rpcUrl = await fakeNode("0x7a69"); // 31337, a local fork

    await expect(startMainnet(confirmed(), { ...roster, rpcUrl })).rejects.toThrow(/chain 31337/);

    expect(new Set(methods)).toEqual(new Set(["eth_chainId"]));
  });

  it("refuses an underfunded set-up having sent nothing: it only reads balances", async () => {
    const rpcUrl = await fakeNode("0xa4ec"); // 42220, Celo mainnet

    await expect(startMainnet(confirmed(), { ...roster, rpcUrl })).rejects.toThrow(/underfunded/);

    expect(methods).toContain("eth_call");
    expect(methods.filter((m) => /^eth_send/.test(m))).toEqual([]);
  });
});
