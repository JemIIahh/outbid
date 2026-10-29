import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../src/arena/events.js";
import { BusyError, createServer, type ServerDeps, type StateSnapshot } from "../../src/server/app.js";

const snapshot: StateSnapshot = {
  ledger: { rounds: [], policyRevoked: false },
  mode: "stub",
  network: "fork",
  policy: { active: true, revoked: false, spendable: "0.50", remainingToday: "5.00", perPayment: "0.50", perDay: "5.00" },
  sellers: [],
};

let server: http.Server | undefined;

async function start(overrides: Partial<ServerDeps> = {}) {
  const deps: ServerDeps = {
    bus: createBus(),
    state: async () => snapshot,
    startRound: vi.fn(async () => ({ rfqId: "rfq-1" })),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
  server = createServer(deps);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { deps, base };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function nextEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const decoder = new TextDecoder();
  let text = "";
  const found: { seq: number; type: string }[] = [];
  while (found.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    found.length = 0;
    for (const line of text.split("\n")) if (line.startsWith("data: ")) found.push(JSON.parse(line.slice(6)));
  }
  return found;
}

describe("event feed", () => {
  it("replays history then streams live events", async () => {
    const bus = createBus();
    bus.emit({ type: "policy.revoked" });
    const { base } = await start({ bus });

    const res = await fetch(`${base}/api/events`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    expect((await nextEvents(reader, 1))[0]).toMatchObject({ seq: 1, type: "policy.revoked" });

    bus.emit({ type: "round.ended", rfqId: "r1", status: "no_winner" });
    expect(await nextEvents(reader, 1)).toMatchObject([{ seq: 2, type: "round.ended" }]);
    await reader.cancel();
  });
});

describe("control routes", () => {
  it("returns the state snapshot", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual(snapshot);
  });

  it("starts a round and answers 202 with its id", async () => {
    const { base, deps } = await start();
    const res = await post(`${base}/api/rounds`, { task: { kind: "summarize", input: "some text" }, budget: "0.20" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ rfqId: "rfq-1" });
    expect(deps.startRound).toHaveBeenCalledTimes(1);
    expect(deps.startRound).toHaveBeenCalledWith({ task: { kind: "summarize", input: "some text" }, budget: "0.20" });
  });

  it("accepts a digest job", async () => {
    const { base, deps } = await start();
    const res = await post(`${base}/api/rounds`, { task: { kind: "digest", input: "some text" }, budget: "0.20" });
    expect(res.status).toBe(202);
    expect(deps.startRound).toHaveBeenCalledWith({ task: { kind: "digest", input: "some text" }, budget: "0.20" });
  });

  it.each([
    ["not JSON", "{nope"],
    ["unknown kind", { task: { kind: "paint", input: "x" }, budget: "0.20" }],
    ["empty input", { task: { kind: "translate", input: "  " }, budget: "0.20" }],
    ["bad budget", { task: { kind: "translate", input: "x" }, budget: "lots" }],
    ["missing task", { budget: "0.20" }],
  ])("rejects a malformed body (%s) with 400 and starts nothing", async (_name, body) => {
    const { base, deps } = await start();
    expect((await post(`${base}/api/rounds`, body)).status).toBe(400);
    expect(deps.startRound).not.toHaveBeenCalled();
  });

  it("answers 409 while another round is running", async () => {
    const { base } = await start({ startRound: async () => { throw new BusyError(); } });
    expect((await post(`${base}/api/rounds`, { task: { kind: "extract", input: "x" }, budget: "0.20" })).status).toBe(409);
  });

  it("revokes the policy on request", async () => {
    const { base, deps } = await start();
    expect((await post(`${base}/api/revoke`, {})).status).toBe(200);
    expect(deps.revoke).toHaveBeenCalledTimes(1);
  });

  it("offers fast-forward only when the environment provides it", async () => {
    const without = await start();
    expect((await post(`${without.base}/api/fast-forward`, {})).status).toBe(404);
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const fastForward = vi.fn(async () => {});
    const withIt = await start({ fastForward });
    expect((await post(`${withIt.base}/api/fast-forward`, {})).status).toBe(200);
    expect(fastForward).toHaveBeenCalledTimes(1);
  });
});

/** A raw request, so a test can set the Host and Origin headers a browser would. */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body = "") {
  const { port } = new URL(base);
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", reject);
    req.end(body);
  });
}

describe("requests from other websites", () => {
  const round = JSON.stringify({ task: { kind: "extract", input: "x" }, budget: "0.20" });
  const json = { "content-type": "application/json" };

  it("refuses a page from another origin and starts nothing", async () => {
    const { base, deps } = await start();
    expect(await raw(base, "POST", "/api/rounds", { ...json, origin: "https://evil.example" }, round)).toBe(403);
    expect(await raw(base, "POST", "/api/revoke", { ...json, origin: "https://evil.example" }, "{}")).toBe(403);
    expect(deps.startRound).not.toHaveBeenCalled();
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("refuses a body that is not declared JSON, which a page can send without asking first", async () => {
    const { base, deps } = await start();
    expect(await raw(base, "POST", "/api/rounds", { "content-type": "text/plain" }, round)).toBe(415);
    expect(deps.startRound).not.toHaveBeenCalled();
  });

  it("refuses a Host that is not this machine, which is how DNS rebinding arrives", async () => {
    const { base, deps } = await start();
    expect(await raw(base, "POST", "/api/rounds", { ...json, host: "evil.example" }, round)).toBe(403);
    expect(await raw(base, "GET", "/api/state", { host: "evil.example" })).toBe(403);
    expect(deps.startRound).not.toHaveBeenCalled();
  });

  it("still accepts the page's own requests", async () => {
    const { base, deps } = await start();
    const { port } = new URL(base);
    expect(await raw(base, "POST", "/api/rounds", { ...json, origin: `http://127.0.0.1:${port}` }, round)).toBe(202);
    expect(await raw(base, "POST", "/api/rounds", { ...json, host: `localhost:${port}`, origin: `http://localhost:${port}` }, round)).toBe(202);
    expect(deps.startRound).toHaveBeenCalledTimes(2);
  });
});

describe("static files", () => {
  it("serves the web root and refuses to leave it", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "outbid-web-"));
    await writeFile(join(webRoot, "index.html"), "<h1>ledger</h1>");
    const { base } = await start({ webRoot });

    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toMatch(/text\/html/);
    expect(await home.text()).toBe("<h1>ledger</h1>");

    const port = new URL(base).port;
    const status = await new Promise<number>((resolve) =>
      http.get({ host: "127.0.0.1", port, path: "/../package.json" }, (res) => (res.resume(), resolve(res.statusCode ?? 0))),
    );
    expect(status).toBe(404);
  });
});
