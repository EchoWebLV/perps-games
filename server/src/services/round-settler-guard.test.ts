import { describe, it, expect } from "vitest";
import { assertRoundSettlerForStake } from "./round-settler-guard.js";

describe("assertRoundSettlerForStake (cash rounds fail closed)", () => {
  it("does NOT throw for coin rounds, even without a settler", () => {
    expect(() =>
      assertRoundSettlerForStake({ stakeAsset: "coin", cashSettlerEnabled: false, roundSettler: null }),
    ).not.toThrow();
  });

  it("throws for cash rounds when CASH_SETTLER_ENABLED is off (the default)", () => {
    expect(() =>
      assertRoundSettlerForStake({ stakeAsset: "cash", cashSettlerEnabled: false, roundSettler: null }),
    ).toThrow(/refusing to boot.*cash.*settler/i);
  });

  it("still throws for cash rounds when the switch is on but no settler is wired", () => {
    expect(() =>
      assertRoundSettlerForStake({ stakeAsset: "cash", cashSettlerEnabled: true, roundSettler: null }),
    ).toThrow(/no autonomous round settler/i);
  });

  it("permits cash rounds only when BOTH the switch is on and a settler is wired", () => {
    const settler = { start() {}, stop() {} };
    expect(() =>
      assertRoundSettlerForStake({ stakeAsset: "cash", cashSettlerEnabled: true, roundSettler: settler }),
    ).not.toThrow();
  });
});
