import { describe, it, expect } from "vitest";
import { BUILDINGS, DOORS, LOT_BOUNDS, LOBBY_SPAWN, PLAZA, doorExitPose, entranceHit, type BuildingKind } from "./lobby-layout";

// "highway" is deliberately absent: the mode lives on for boot-restore, the storefront does not
const KINDS: BuildingKind[] = ["garage", "upgrades", "crates", "track", "race", "scrapyard"];
const find = (k: BuildingKind) => BUILDINGS.find((b) => b.kind === k)!;

describe("lobby-layout", () => {
  it("has one building + one door per functional kind", () => {
    expect(BUILDINGS.map((b) => b.kind).sort()).toEqual([...KINDS].sort());
    expect(DOORS.map((d) => d.kind).sort()).toEqual([...KINDS].sort());
  });

  it("flags ScrapYard as coming soon (no interaction wired yet)", () => {
    expect(find("scrapyard").comingSoon).toBe(true);
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

  // ---- Ring / town-square layout ----

  it("rings the plaza with mirrored pairs across the x=0 centreline", () => {
    const pairs: Array<[BuildingKind, BuildingKind]> = [
      ["garage", "upgrades"],
      ["crates", "scrapyard"],
      ["track", "race"],
    ];
    for (const [east, west] of pairs) {
      const e = find(east), w = find(west);
      expect(e.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(0);
      expect(e.x).toBeCloseTo(-w.x, 5);
      expect(e.z).toBeCloseTo(w.z, 5);
    }
  });

  it("turns every building to face the plaza centre (readable from inside)", () => {
    for (const b of BUILDINGS) {
      const fx = Math.sin(b.rot), fz = Math.cos(b.rot); // front direction = (sin rot, cos rot)
      const len = Math.hypot(b.x, b.z);
      const inwardDot = (fx * -b.x + fz * -b.z) / len; // 1 = points exactly at the centre
      expect(inwardDot).toBeGreaterThan(0.99);
    }
  });

  it("leaves the south side open as the entrance — no building blocks the approach", () => {
    for (const b of BUILDINGS) {
      const inCorridor = Math.abs(b.x) < PLAZA.loopWidth / 2 && b.z > 10 && b.z < 110;
      expect(inCorridor).toBe(false);
    }
  });

  it("spawns the player on the south approach into the plaza, clear of every door", () => {
    expect(LOBBY_SPAWN.x).toBeCloseTo(PLAZA.entrance.from.x, 5);
    const zMin = Math.min(PLAZA.entrance.from.z, PLAZA.entrance.to.z);
    const zMax = Math.max(PLAZA.entrance.from.z, PLAZA.entrance.to.z);
    expect(LOBBY_SPAWN.z).toBeGreaterThanOrEqual(zMin);
    expect(LOBBY_SPAWN.z).toBeLessThanOrEqual(zMax);
    expect(entranceHit(LOBBY_SPAWN.x, LOBBY_SPAWN.z)).toBeNull();
  });

  it("has a loop road ringing a central plaza", () => {
    expect(PLAZA.center).toEqual({ x: 0, z: 0 });
    expect(PLAZA.loopRadius).toBeGreaterThan(0);
    expect(PLAZA.loopWidth).toBeGreaterThan(0);
  });
});

describe("doorExitPose", () => {
  const door = (k: BuildingKind) => DOORS.find((d) => d.kind === k)!;

  // exiting Garage/Track should drop the car just outside that door, nosed BACK at the
  // building it left (you instantly see where you came from), not aimed at the plaza.
  for (const kind of ["garage", "track"] as const) {
    it(`emerges outside the ${kind} door ring, nose pointed back at the building`, () => {
      const pose = doorExitPose(kind)!;
      const d = door(kind);
      const b = find(kind);

      // (a) clear of the door ring — driving off can't instantly re-trigger the entry
      expect(Math.hypot(pose.x - d.x, pose.z - d.z)).toBeGreaterThan(d.r);

      // (b) forward = (sin heading, -cos heading) points at the building it just left
      const fwd = { x: Math.sin(pose.heading), z: -Math.cos(pose.heading) };
      const len = Math.hypot(b.x - pose.x, b.z - pose.z);
      const toB = { x: (b.x - pose.x) / len, z: (b.z - pose.z) / len };
      expect(fwd.x * toB.x + fwd.z * toB.z).toBeGreaterThan(0.99);
    });
  }

  it("returns null for an unknown kind", () => {
    expect(doorExitPose("nope" as unknown as BuildingKind)).toBeNull();
  });
});
