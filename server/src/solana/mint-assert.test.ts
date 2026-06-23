import { describe, it, expect } from "vitest";
import { assertUsdcMint } from "./mint-assert.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

const ok = { decimals: 6, programAddress: LEGACY_TOKEN_PROGRAM };

describe("assertUsdcMint", () => {
  it("passes for a 6-decimal legacy-SPL mint", async () => {
    await expect(assertUsdcMint(async () => ok, "USDCmint")).resolves.toBeUndefined();
  });
  it("THROWS on wrong decimals", async () => {
    await expect(assertUsdcMint(async () => ({ ...ok, decimals: 9 }), "USDCmint")).rejects.toThrow(/decimals/i);
  });
  it("THROWS on Token-2022 / non-legacy program", async () => {
    await expect(assertUsdcMint(async () => ({ ...ok, programAddress: "Tokenz" }), "USDCmint")).rejects.toThrow(/legacy SPL|program/i);
  });
});
