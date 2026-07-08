import { describe, expect, test } from "vitest";
import { DRESSING_KB, STRIP_SLOTS, lightestSpecs } from "./stripcars";
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

// The low tier parks only the lightest GLBs (the town-square dressing is the lobby's
// vertex mountain on Mali-class GPUs) — lightestSpecs is the pure picker main.ts uses.
describe("lightestSpecs (low-tier dressing diet)", () => {
  const kb = { "/m/light.glb": 5_000, "/m/mid.glb": 12_000, "/m/heavy.glb": 20_000 };
  const spec = (url: string) => ({ url, tag: url });

  test("picks the n lightest by GLB weight, lightest first", () => {
    const picked = lightestSpecs([spec("/m/heavy.glb"), spec("/m/light.glb"), spec("/m/mid.glb")], 2, kb);
    expect(picked.map((s) => s.url)).toEqual(["/m/light.glb", "/m/mid.glb"]);
  });

  test("an unknown url sorts heaviest — it never displaces a known-light model", () => {
    const picked = lightestSpecs([spec("/m/unknown.glb"), spec("/m/heavy.glb"), spec("/m/light.glb")], 2, kb);
    expect(picked.map((s) => s.url)).toEqual(["/m/light.glb", "/m/heavy.glb"]);
  });

  test("n >= list length keeps everything (still light-first) and never mutates the input", () => {
    const input = [spec("/m/heavy.glb"), spec("/m/light.glb")];
    const before = input.map((s) => s.url);
    expect(lightestSpecs(input, 5, kb).map((s) => s.url)).toEqual(["/m/light.glb", "/m/heavy.glb"]);
    expect(input.map((s) => s.url)).toEqual(before);
  });

  test("the shipped weight table knows every lobby-dressing GLB main.ts parks", () => {
    for (const url of [
      "/models/skull.glb", "/models/pink-rod.glb", "/models/six-wheeler.glb",
      "/models/clown-car.glb", "/models/slot-machine.glb",
      "/models/magnet.glb", "/models/shopping-cart.glb",
    ]) {
      expect(DRESSING_KB[url]).toBeGreaterThan(0);
    }
  });

  test("on the real table, the two lightest heroes are skull + clown-car", () => {
    const meet = ["/models/skull.glb", "/models/pink-rod.glb", "/models/six-wheeler.glb", "/models/clown-car.glb", "/models/slot-machine.glb"].map(spec);
    expect(lightestSpecs(meet, 2).map((s) => s.url)).toEqual(["/models/skull.glb", "/models/clown-car.glb"]);
  });
});
