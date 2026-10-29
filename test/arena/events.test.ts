import { describe, expect, it } from "vitest";
import { createBus } from "../../src/arena/events.js";

describe("event bus", () => {
  it("stamps events with a seq starting at 1 and delivers them to subscribers in order", () => {
    const bus = createBus(() => 1000);
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));

    const first = bus.emit({ type: "policy.revoked" });
    bus.emit({ type: "policy.revoked" });

    expect(first).toMatchObject({ seq: 1, at: 1000, type: "policy.revoked" });
    expect(seen).toEqual([1, 2]);
  });

  it("stops delivering to a subscriber after it unsubscribes", () => {
    const bus = createBus();
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.seq));

    bus.emit({ type: "policy.revoked" });
    off();
    bus.emit({ type: "policy.revoked" });

    expect(seen).toEqual([1]);
  });

  it("keeps every emitted event in history", () => {
    const bus = createBus();
    bus.emit({ type: "policy.revoked" });
    bus.emit({ type: "round.ended", rfqId: "r1", status: "no_winner" });

    expect(bus.history().map((e) => e.type)).toEqual(["policy.revoked", "round.ended"]);
  });
});
