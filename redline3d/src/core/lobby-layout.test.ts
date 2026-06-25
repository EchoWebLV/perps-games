import { describe, it, expect } from "vitest";
import { BUILDINGS, DOORS, LOT_BOUNDS, entranceHit, type BuildingKind } from "./lobby-layout";

const KINDS: BuildingKind[] = ["garage", "upgrades", "crates", "track"];

describe("lobby-layout", () => {
  it("has one building + one door per functional kind", () => {
    expect(BUILDINGS.map((b) => b.kind).sort()).toEqual([...KINDS].sort());
    expect(DOORS.map((d) => d.kind).sort()).toEqual([...KINDS].sort());
  });

  it("keeps every building inside the lot bounds", () => {
    for (const b of BUILDINGS) {
      expect(Math.abs(b.x) + b.w / 2).toBeLessThanOrEqual(LOT_BOUNDS.x);
      expect(Math.abs(b.z) + b.d / 2).toBeLessThanOrEqual(LOT_BOUNDS.z);
    }
  });

  it("returns the matching kind at a doorway centre", () => {
    for (const d of DOORS) expect(entranceHit(d.x, d.z)).toBe(d.kind);
  });

  it("returns null far from every door", () => {
    expect(entranceHit(0, LOT_BOUNDS.z)).toBeNull();
  });

  it("has non-overlapping doors", () => {
    for (let i = 0; i < DOORS.length; i++)
      for (let j = i + 1; j < DOORS.length; j++) {
        const a = DOORS[i], b = DOORS[j];
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        expect(dist).toBeGreaterThan(a.r + b.r);
      }
  });
});
