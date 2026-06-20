import { describe, it, expect } from "vitest";
import { makeStubFeed } from "./stub.js";

describe("makeStubFeed", () => {
  it("current() returns the set tick", () => {
    const f = makeStubFeed({ SOL: { price: 150, tsUs: 1_000 } });
    expect(f.current("SOL")).toEqual({ price: 150, tsUs: 1_000 });
  });

  it("current() throws for an asset that never received a tick", () => {
    const f = makeStubFeed();
    expect(() => f.current("BTC")).toThrow();
  });

  it("healthy() is false until a tick arrives, true after", () => {
    const f = makeStubFeed();
    expect(f.healthy("SOL")).toBe(false);
    f.set("SOL", { price: 150, tsUs: 1_000 });
    expect(f.healthy("SOL")).toBe(true);
  });

  it("setHealthy(false) forces a HALT even with a tick present", () => {
    const f = makeStubFeed({ SOL: { price: 150, tsUs: 1_000 } });
    f.setHealthy("SOL", false);
    expect(f.healthy("SOL")).toBe(false);
    // current() still returns the last tick (HALT is a settlement gate, not data loss)
    expect(f.current("SOL").price).toBe(150);
  });
});
