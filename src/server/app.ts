import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reputation } from "../agents/scoring.js";
import type { Bus, StampedEvent } from "../arena/events.js";
import type { LedgerState } from "../arena/ledger.js";
import type { Task, TaskKind } from "../arena/types.js";

export class BusyError extends Error {
  constructor() {
    super("a round is already running");
    this.name = "BusyError";
  }
}

export type StateSnapshot = {
  ledger: LedgerState;
  mode: "claude" | "stub";
  network: "fork" | "mainnet";
  policy: { active: boolean; revoked: boolean; spendable: string; remainingToday: string; perPayment: string; perDay: string };
  sellers: { name: string; address: string; kinds: TaskKind[]; etaMs: number; reputation: Reputation | null }[];
};

export type ServerDeps = {
  bus: Bus;
  state(): Promise<StateSnapshot>;
  /** Resolves once the RFQ is open. Throws `BusyError` if a round is already running. */
  startRound(req: { task: Task; budget: string }): Promise<{ rfqId: string }>;
  revoke(): Promise<void>;
  /** Only on the local fork: mines enough blocks to finalize recent payments. */
  fastForward?(): Promise<void>;
  webRoot?: string;
};

const MAX_BODY = 16 * 1024;
const MAX_INPUT = 4000;
const KINDS: ReadonlySet<string> = new Set<TaskKind>(["translate", "summarize", "extract", "digest"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const DEFAULT_WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");

function parseRoundRequest(body: unknown): { task: Task; budget: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { task, budget } = body as { task?: { kind?: unknown; input?: unknown }; budget?: unknown };
  if (typeof task?.kind !== "string" || !KINDS.has(task.kind)) return null;
  if (typeof task.input !== "string" || task.input.trim() === "" || task.input.length > MAX_INPUT) return null;
  if (typeof budget !== "string" || !/^\d+(\.\d{1,6})?$/.test(budget) || Number(budget) <= 0) return null;
  return { task: { kind: task.kind as TaskKind, input: task.input }, budget };
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) return reject(Object.assign(new Error("body too large"), { status: 413 }));
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolveBody(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const frame = (event: StampedEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

export function createServer(deps: ServerDeps): http.Server {
  const webRoot = resolve(deps.webRoot ?? DEFAULT_WEB_ROOT);

  async function serveFile(pathname: string, res: http.ServerResponse): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 404, { error: "not found" });
    }
    const file = resolve(join(webRoot, decoded === "/" ? "index.html" : decoded));
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return send(res, 404, { error: "not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      send(res, 404, { error: "not found" });
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const post = req.method === "POST";

    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of deps.bus.history()) res.write(frame(event));
      const off = deps.bus.subscribe((event) => res.write(frame(event)));
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      heartbeat.unref();
      req.on("close", () => (off(), clearInterval(heartbeat)));
      return;
    }
    if (pathname === "/api/state" && req.method === "GET") return send(res, 200, await deps.state());

    if (pathname === "/api/rounds") {
      if (!post) return send(res, 405, { error: "use POST" });
      const parsed = parseRoundRequest(await readJson(req));
      if (!parsed) return send(res, 400, { error: "expected { task: { kind: translate|summarize|extract|digest, input }, budget: \"0.20\" }" });
      return send(res, 202, await deps.startRound(parsed));
    }
    if (pathname === "/api/revoke") {
      if (!post) return send(res, 405, { error: "use POST" });
      await deps.revoke();
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/fast-forward") {
      if (!deps.fastForward) return send(res, 404, { error: "not available here" });
      if (!post) return send(res, 405, { error: "use POST" });
      await deps.fastForward();
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (req.method === "GET") return serveFile(pathname, res);
    return send(res, 405, { error: "method not allowed" });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      if (error instanceof BusyError) return send(res, 409, { error: error.message });
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 413) return send(res, status, { error: (error as Error).message });
      send(res, 500, { error: "internal error" });
    });
  });
}
