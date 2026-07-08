import { describe, expect, test } from "vitest";
import { DEMO_FEED, fmtEntry } from "./billboard";

describe("strip billboard entries", () => {
  test("banked entries read multiplier + SOL in player-speak", () => {
    expect(fmtEntry({ tag: "liq_dodger", mult: 14.2, sol: 0.71 })).toBe("liq_dodger banked ×14.20 · +0.71 SOL");
  });

  test("a banked entry without a SOL figure still reads clean", () => {
    expect(fmtEntry({ tag: "honkmaster", mult: 1.9 })).toBe("honkmaster banked ×1.90");
  });

  test("wrecks read as wrecks, never negative multipliers", () => {
    expect(fmtEntry({ tag: "haulin_hal", mult: 0 })).toBe("haulin_hal wrecked ×0.00");
    expect(fmtEntry({ tag: "haulin_hal", mult: -3 })).toBe("haulin_hal wrecked ×0.00");
  });

  test("demo feed has both wins and wrecks so the board doesn't read rigged", () => {
    expect(DEMO_FEED.some((e) => e.mult === 0)).toBe(true);
    expect(DEMO_FEED.some((e) => e.mult > 1)).toBe(true);
  });
});
