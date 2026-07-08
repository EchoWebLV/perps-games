import { describe, expect, test } from "vitest";
import { LAP, cruiserPose } from "./cruisers";
import { STRIP_SLOTS } from "./stripcars";
import { DOORS, LOBBY_SPAWN, LOT_BOUNDS } from "../core/lobby-layout";

// The lap is decorative, but it threads real geometry: walls outside, the parked meet
// inside, storefront aprons north. Sample the whole ellipse and pin the clearances so a
// layout change that crosses the lap fails here, not on screen.

const SAMPLES = Array.from({ length: 96 }, (_, i) => cruiserPose((i / 96) * Math.PI * 2));

describe("cruiser lap", () => {
  test("stays inside the lot walls", () => {
    for (const p of SAMPLES) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(LOT_BOUNDS.x - 6);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(LOT_BOUNDS.z - 6);
    }
  });

  test("never drives through a parked car or the spawn pad", () => {
    for (const p of SAMPLES) {
      for (const s of STRIP_SLOTS) {
        expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeGreaterThanOrEqual(8);
      }
      expect(Math.hypot(p.x - LOBBY_SPAWN.x, p.z - LOBBY_SPAWN.z)).toBeGreaterThanOrEqual(10);
    }
  });

  test("clears every storefront apron (door-ring centres)", () => {
    // rings are player triggers, not colliders — but a cruiser parked IN one reads wrong.
    // Require the lap to keep a car-width from each ring centre.
    for (const p of SAMPLES) {
      for (const d of DOORS) {
        expect(Math.hypot(p.x - d.x, p.z - d.z)).toBeGreaterThanOrEqual(d.r - 4);
      }
    }
  });

  test("faces along its direction of travel", () => {
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      const a = cruiserPose(t), b = cruiserPose(t + 0.01);
      const vx = b.x - a.x, vz = b.z - a.z;
      const expected = Math.atan2(-vx, -vz);
      // compare angles on the circle (wraparound-safe)
      const diff = Math.atan2(Math.sin(a.rot - expected), Math.cos(a.rot - expected));
      expect(Math.abs(diff)).toBeLessThan(0.02);
    }
  });

  test("the lap ellipse is where the layout thinks it is", () => {
    expect(LAP).toEqual({ cx: 0, cz: 0, rx: 40, rz: 40 });
  });
});
