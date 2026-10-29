import { describe, expect, it } from "vitest";
import { describeError } from "../../src/arena/errors.js";

describe("describeError", () => {
  it("keeps a plain message", () => {
    expect(describeError(new Error("the policy has no room left today"))).toBe("the policy has no room left today");
    expect(describeError("boom")).toBe("boom");
  });

  it("drops web addresses, so a keyed RPC url never reaches the event feed", () => {
    const rpc = new Error('HTTP request failed.\n\nURL: https://celo.example.com/v2/SECRETKEY?token=abc\nRequest body: {"method":"eth_call"}');

    const text = describeError(rpc);

    expect(text).not.toMatch(/SECRETKEY|token=abc|https?:/);
    expect(text).toMatch(/HTTP request failed/);
  });

  it("is one short line", () => {
    const text = describeError(new Error(`first line\nsecond line ${"x".repeat(500)}`));
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
