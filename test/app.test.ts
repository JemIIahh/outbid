import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { BusyError } from "../src/server/app.js";

let app: App;

beforeAll(async () => {
  app = await createApp({}, { finalityPollMs: 60_000 });
});
afterAll(async () => {
  await app?.close();
});

const job = { task: { kind: "translate" as const, input: "Good morning, the shipment arrives on Friday." }, budget: "0.20" };

const ended = (rfqId: string) =>
  new Promise<void>((resolve) => {
    const off = app.bus.subscribe((e) => e.type === "round.ended" && e.rfqId === rfqId && (off(), resolve()));
  });

describe("demo app", () => {
  it("offers digest from every generalist and from the two specialists that hire each other", async () => {
    const { sellers } = await app.state();
    for (const name of ["Quill", "Marrow", "Vesper", "Lex", "Gist"]) {
      expect(sellers.find((s) => s.name === name)!.kinds).toContain("digest");
    }
    expect(sellers.find((s) => s.name === "Lex")!.kinds).not.toContain("summarize");
  });

  it("runs a digest round to the end, whoever wins", async () => {
    const { rfqId } = await app.startRound({ task: { kind: "digest", input: job.task.input }, budget: "0.20" });
    await ended(rfqId);

    const events = app.bus.history().filter((e) => "rfqId" in e && e.rfqId === rfqId);
    expect(events.at(-1)).toMatchObject({ type: "round.ended", status: "delivered" });
    expect(events.filter((e) => e.type === "payment.sent")).toHaveLength(1);
  });

  it("accepts the next round as soon as the previous one has ended", async () => {
    const first = await app.startRound(job);
    await ended(first.rfqId);

    // Reacting to round.ended (as a UI does) must be enough to start again.
    const second = await app.startRound(job);
    await ended(second.rfqId);

    expect(second.rfqId).not.toBe(first.rfqId);
  });

  it("refuses a second round while one is still running", async () => {
    const first = await app.startRound(job);
    expect(() => app.startRound(job)).toThrow(BusyError);
    await ended(first.rfqId);
  });
});
