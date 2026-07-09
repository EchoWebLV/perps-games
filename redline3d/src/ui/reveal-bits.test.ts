import { describe, expect, test } from "vitest";
import { pileShards, scrapPileHtml, levelPosterHtml, type LevelPoster } from "./reveal-bits";

describe("pileShards — heap size scales with the scrap amount", () => {
  test("more scrap → more shards, clamped to a sane range", () => {
    expect(pileShards(0)).toBe(0);        // nothing → no pile
    expect(pileShards(25)).toBe(4);       // wooden base
    expect(pileShards(300)).toBe(6);      // silver base
    expect(pileShards(800)).toBe(8);      // gold base
    expect(pileShards(5000)).toBe(10);    // clamp
  });
  test("monotonic non-decreasing", () => {
    let prev = -1;
    for (const n of [0, 10, 25, 100, 300, 800, 2000]) { const s = pileShards(n); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
  });
});

describe("scrapPileHtml", () => {
  test("renders the amount and one shard element per pileShards(n)", () => {
    const html = scrapPileHtml(300);
    expect(html).toContain("+300");
    const shards = (html.match(/cb-shard/g) ?? []).length;
    expect(shards).toBe(pileShards(300));
  });
});

describe("levelPosterHtml", () => {
  const info: LevelPoster = { name: "Neon City", sky: ["#050a24", "#123a6a"], disc: "#9fc0ee", grid: ["#ff39c0", "#27e7ff"] };
  test("shows the skin name and paints from the theme palette", () => {
    const html = levelPosterHtml(info);
    expect(html).toContain("Neon City");
    expect(html).toContain("#123a6a"); // sky
    expect(html).toContain("#9fc0ee"); // celestial disc
    expect(html).toContain("#27e7ff"); // grid
    expect(html).toContain("NEW LEVEL");
  });
});
