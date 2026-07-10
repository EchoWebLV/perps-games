import { describe, it, expect, vi } from "vitest";
import { createCrateRollDraws } from "./crate-roll";

const slot = (nonce: number, fulfilled: boolean, fill = 0x80) =>
  ({ nonce, fulfilled, randomness: new Uint8Array(32).fill(fill) });

describe("createCrateRollDraws", () => {
  it("requests, polls until the matching nonce fulfills, returns derived draws", async () => {
    const states = [slot(1, false), slot(2, false), slot(2, true)]; // pre-state nonce 1; request bumps to 2
    const io = {
      fetchSlot: vi.fn(async () => states.shift() ?? slot(2, true)),
      request: vi.fn(async () => {}),
      sleep: async () => {},
    };
    const draws = await createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4);
    expect(io.request).toHaveBeenCalledOnce();
    expect(draws).toHaveLength(4);
    expect(draws[0]).toBeCloseTo(0x8080808080808080 / 2 ** 64, 10);
  });
  it("ignores a stale fulfillment (nonce below the requested one)", async () => {
    const states = [slot(1, false), slot(1, true, 0x11), slot(2, true, 0x22)]; // pre-state nonce 1
    const io = { fetchSlot: vi.fn(async () => states.shift() ?? slot(2, true, 0x22)), request: async () => {}, sleep: async () => {} };
    const draws = await createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4);
    expect(draws[0]).toBeCloseTo(0x2222222222222222 / 2 ** 64, 10); // waited for nonce 2, not stale 1
  });
  it("times out and throws vrf_timeout", async () => {
    const io = { fetchSlot: async () => slot(1, false), request: async () => {}, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 6000); })() };
    await expect(createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4)).rejects.toThrow("vrf_timeout");
  });
});
