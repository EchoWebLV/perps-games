import { describe, expect, it } from "vitest";
import { FEED_SYMBOLS, hermesIdOf, feedAssetKeys } from "./symbols.js";

describe("feed symbols", () => {
  it("carries the launch crypto set", () => {
    expect(feedAssetKeys()).toEqual(["BTC", "ETH", "SOL"]);
    expect(hermesIdOf("BTC")).toBe("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43");
  });
  it("every entry has a 64-hex hermes id (equities later just add rows)", () => {
    for (const s of Object.values(FEED_SYMBOLS)) expect(s.hermesId).toMatch(/^[0-9a-f]{64}$/);
  });
});
