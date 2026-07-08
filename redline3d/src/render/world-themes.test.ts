import { describe, it, expect } from "vitest";
import { THEMES, DEFAULT_KEY, themeKeys, isThemeKey, getTheme, nextThemeKey, resolveThemeKey } from "./world-themes";

describe("world-themes", () => {
  it("includes the synthwave default and it is a valid registered key", () => {
    expect(DEFAULT_KEY).toBe("synthwave");
    expect(isThemeKey(DEFAULT_KEY)).toBe(true);
    expect(getTheme(DEFAULT_KEY).key).toBe("synthwave");
  });

  it("every theme has a unique key and a full palette", () => {
    const keys = THEMES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length); // no dupes
    for (const t of THEMES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.sky.length).toBe(2);
      expect(t.lights.length).toBe(2); // left + right lamp colours
      expect(t.grid.length).toBe(2);
    }
  });

  it("getTheme falls back to the default for an unknown key", () => {
    expect(getTheme("does-not-exist").key).toBe(DEFAULT_KEY);
  });

  it("nextThemeKey cycles through every key and wraps around", () => {
    const keys = themeKeys();
    let k = keys[0];
    const seen = [k];
    for (let i = 0; i < keys.length - 1; i++) { k = nextThemeKey(k); seen.push(k); }
    expect(new Set(seen).size).toBe(keys.length); // visited them all
    expect(nextThemeKey(keys[keys.length - 1])).toBe(keys[0]); // wraps
  });

  it("nextThemeKey treats an unknown key as before the first", () => {
    expect(nextThemeKey("bogus")).toBe(themeKeys()[0]);
  });

  it("resolveThemeKey returns a valid stored key, else the default", () => {
    expect(resolveThemeKey("synthwave")).toBe("synthwave");
    expect(resolveThemeKey(null)).toBe(DEFAULT_KEY);
    expect(resolveThemeKey("garbage")).toBe(DEFAULT_KEY);
  });
});
