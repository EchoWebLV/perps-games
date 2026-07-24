import { describe, expect, it } from "vitest";
import type { CarOption } from "../ui/carpicker";
import { GRID_SIZE, STRENGTH, surgeAmpBonus, buildGrid } from "./race-grid";

const car = (name: string, rarity: 1 | 2 | 3 | 4 | 5, extra: Partial<CarOption> = {}): CarOption =>
  ({ name, url: `/models/${name.toLowerCase()}.glb`, rarity, ...extra });

const ROSTER: CarOption[] = [
  car("Alpha", 1), car("Bravo", 2), car("Charlie", 3), car("Delta", 4, { ability: "nitro" }),
  car("Echo", 5), car("Foxtrot", 3), car("Golf", 2), car("Hotel", 1), car("India", 4),
];

// deterministic rng stub: cycles a fixed tape so tests never flake
const rngTape = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };

describe("buildGrid", () => {
  it("puts the player's car first and fills to GRID_SIZE with distinct house cars", () => {
    const grid = buildGrid(ROSTER, "Charlie", rngTape([0.1, 0.9, 0.4, 0.7, 0.2, 0.6, 0.3]));
    expect(grid).toHaveLength(GRID_SIZE);
    expect(grid[0].name).toBe("Charlie");
    expect(grid[0].isPlayer).toBe(true);
    expect(grid.slice(1).every((e) => !e.isPlayer)).toBe(true);
    expect(new Set(grid.map((e) => e.name)).size).toBe(GRID_SIZE); // no duplicates
  });
  it("builds an all-house grid for spectate mode (null player car)", () => {
    const grid = buildGrid(ROSTER, null, rngTape([0.5, 0.15, 0.85, 0.35, 0.65, 0.05, 0.95, 0.45]));
    expect(grid).toHaveLength(GRID_SIZE);
    expect(grid.every((e) => !e.isPlayer)).toBe(true);
  });
  it("carries model url/scale/yaw and maps rarity to strength", () => {
    const grid = buildGrid(ROSTER, "Echo", rngTape([0.2, 0.4, 0.6, 0.8]));
    expect(grid[0].url).toBe("/models/echo.glb");
    expect(grid[0].strength).toBe(STRENGTH[5]);
  });
  it("gives ability cars their surge amp bonus", () => {
    expect(surgeAmpBonus("nitro")).toBeGreaterThan(0);
    expect(surgeAmpBonus(undefined)).toBe(0);
    const grid = buildGrid(ROSTER, "Delta", rngTape([0.3, 0.7, 0.1, 0.9]));
    expect(grid[0].surgeAmpBonus).toBe(surgeAmpBonus("nitro"));
  });
  it("excludes pool:false and comingSoon cars from house fill", () => {
    const roster = [...ROSTER, car("Benched", 3, { pool: false }), car("Taped", 3, { comingSoon: true })];
    for (let s = 0; s < 20; s++) {
      const grid = buildGrid(roster, "Alpha", rngTape([s / 20, 0.33, 0.77, 0.51]));
      expect(grid.some((e) => e.name === "Benched" || e.name === "Taped")).toBe(false);
    }
  });
});
