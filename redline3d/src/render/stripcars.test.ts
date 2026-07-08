import { describe, expect, test } from "vitest";
import { STRIP_SLOTS } from "./stripcars";
import { DOORS, LOBBY_SPAWN, LOT_BOUNDS, entranceHit } from "../core/lobby-layout";

// The parked cars are set dressing, but they share the lot with real gameplay geometry.
// These tests pin the layout contract: if the building arc or a door ring moves in
// lobby-layout.ts, a slot that now clips it fails here instead of clipping in-game.

const CAR_CLEARANCE = 8; // ~half a car footprint + breathing room

describe("strip parked-car slots", () => {
  test("stay inside the lot walls with room for the car body", () => {
    for (const s of STRIP_SLOTS) {
      expect(Math.abs(s.x)).toBeLessThanOrEqual(LOT_BOUNDS.x - CAR_CLEARANCE);
      expect(Math.abs(s.z)).toBeLessThanOrEqual(LOT_BOUNDS.z - CAR_CLEARANCE);
    }
  });

  test("clear every door ring — a parked car must never sit in an entrance", () => {
    for (const s of STRIP_SLOTS) {
      // the slot's own centre must not trigger a door…
      expect(entranceHit(s.x, s.z)).toBeNull();
      // …and the car's footprint must not overlap the ring either
      for (const d of DOORS) {
        const dist = Math.hypot(s.x - d.x, s.z - d.z);
        expect(dist).toBeGreaterThanOrEqual(d.r + CAR_CLEARANCE);
      }
    }
  });

  test("leave the spawn pad clear so the player never boots inside a prop", () => {
    for (const s of STRIP_SLOTS) {
      expect(Math.hypot(s.x - LOBBY_SPAWN.x, s.z - LOBBY_SPAWN.z)).toBeGreaterThanOrEqual(12);
    }
  });

  test("don't overlap each other", () => {
    for (let i = 0; i < STRIP_SLOTS.length; i++) {
      for (let j = i + 1; j < STRIP_SLOTS.length; j++) {
        const a = STRIP_SLOTS[i], b = STRIP_SLOTS[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(11);
      }
    }
  });
});
