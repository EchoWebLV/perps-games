import { describe, it, expect } from "vitest";
import { perkEnvelope, carPerk } from "@perps/engine/entitlements";
import { trackValue } from "../ui/upgrades";
import { CONFIG } from "./config";

/**
 * PARITY GUARD (Phase 1): pins the shared @perps/engine/entitlements module to what the CLIENT'S
 * OWN live formulas produce. Until Phase 2 refactors the client to consume the shared module,
 * the client math (ui/upgrades.ts trackValue over CONFIG + main.ts effRmax/effMaxSec) is the
 * behavioral baseline — if any case here mismatches, the SHARED MODULE drifted and this test
 * must break CI, not be "fixed".
 *
 * CONFIG is mutable at runtime (the garage upgrade tree writes RMAX/MAXSEC/LIQ), but in this
 * test's fresh module graph no upgrades instance is ever created, so it holds the base values
 * (RMAX 1000, MAXSEC 60, LIQ 0.2).
 *
 * Client constants that aren't exported are used as literals, each named to its source:
 *   - track steps 50 / 6 / -0.01  → ui/upgrades.ts TRACKS (lines 35-37)
 *   - HEAVY_LEV 0.5, HEAVY_DUR 1.5, HEAVY_PLAY_CAP 25 → main.ts:317 (not imported — main.ts boots the game)
 *   - nitro ×2 → ui/nitro.ts:10 NITRO_MULT (kept as a literal for symmetry with the other perks)
 *   - default stake cap 10 → ui/controls.ts:4 DEFAULT_PLAY_CAP
 * Client recomputations go through Math.round because the engine rounds via clampInt — e.g.
 * (0.2 - 0.01*10) * 1e6 is floating-point junk without it.
 */
const L = (turbo = 0, tank = 0, suspension = 0) => ({ turbo, tank, suspension });

describe("perkEnvelope parity with the client's live formulas", () => {
  it("maxed turbo, stock car: maxLev matches trackValue over CONFIG.RMAX", () => {
    const client = Math.round(trackValue(CONFIG.RMAX, 50, 10));
    expect(perkEnvelope(L(10), {}).maxLev).toBe(client);
    expect(client).toBe(1500);
  });

  it("maxed tank: maxDurSecs matches trackValue over CONFIG.MAXSEC", () => {
    const client = Math.round(trackValue(CONFIG.MAXSEC, 6, 10));
    expect(perkEnvelope(L(0, 10), {}).maxDurSecs).toBe(client);
    expect(client).toBe(120);
  });

  it("maxed suspension: minLiqFp matches trackValue over CONFIG.LIQ in fixed-point", () => {
    const client = Math.round(trackValue(CONFIG.LIQ, -0.01, 10) * 1_000_000);
    expect(perkEnvelope(L(0, 0, 10), {}).minLiqFp).toBe(client);
    expect(client).toBe(100_000);
  });

  it("Six Wheeler maxed: matches main.ts:318-319 effRmax/effMaxSec (round AFTER the multiplier)", () => {
    const e = perkEnvelope(L(10, 10), carPerk("Six Wheeler"));
    const clientLev = Math.round(trackValue(CONFIG.RMAX, 50, 10) * 0.5);  // effRmax, HEAVY_LEV=0.5
    const clientDur = Math.round(trackValue(CONFIG.MAXSEC, 6, 10) * 1.5); // effMaxSec, HEAVY_DUR=1.5
    expect(e.maxLev).toBe(clientLev);
    expect(clientLev).toBe(750);
    expect(e.maxDurSecs).toBe(clientDur);
    expect(clientDur).toBe(180);
    expect(e.maxStakeUnits).toBe(25); // HEAVY_PLAY_CAP, main.ts:317
  });

  it("Cybertruck at level 0: baseLev floors the ceiling at 1500 (main.ts CAR_DEFS + effRmax's Math.max)", () => {
    expect(perkEnvelope(L(), carPerk("Cybertruck")).maxLev).toBe(1500);
  });

  it("Orion nitro grants ×2 transient headroom over the stock ceiling (ui/nitro.ts NITRO_MULT)", () => {
    expect(perkEnvelope(L(10), carPerk("Orion")).maxLev).toBe(2 * perkEnvelope(L(10), {}).maxLev);
    expect(perkEnvelope(L(10), carPerk("Orion")).maxLev).toBe(3000);
  });

  it("stock car, no upgrades: the full base envelope", () => {
    expect(perkEnvelope(L(), {})).toEqual({
      maxLev: Math.round(CONFIG.RMAX),
      maxDurSecs: 60,
      minLiqFp: 200_000,
      graceSecs: 0,
      slTpAllowed: false,
      refundFp: 0,
      maxStakeUnits: 10, // DEFAULT_PLAY_CAP, ui/controls.ts:4
    });
  });
});
