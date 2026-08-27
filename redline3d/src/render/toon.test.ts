import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("toon default", () => {
  it("boots CLASSIC when toon.enabled is unset", async () => {
    const src = await readFile(new URL("./toon.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export const TOON_DEFAULT = false/);
    expect(src).toMatch(/raw == null \? TOON_DEFAULT/);
  });
});
