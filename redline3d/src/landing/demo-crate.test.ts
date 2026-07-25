import { describe, expect, it } from "vitest";
import { DEMO_CARS, rollDemo } from "./demo-crate";
import mainSrc from "../main.ts?raw";

// node builtins are pulled dynamically through a string variable so vite-plugin-node-polyfills (see
// vite.config.ts) can't statically rewrite `node:url`/`node:fs` to its browser proxies — the same
// indirection landing-shell.test.ts relies on. The assertions below are otherwise verbatim.

describe("landing demo crate", () => {
  it("mirrors every pullable CAR_DEFS entry (name + rarity)", () => {
    const defs = [...mainSrc.matchAll(/\{ name: "([^"]+)"[^\n]*?rarity: (\d)[^\n]*/g)]
      .filter((m) => !/pool: false|comingSoon: true/.test(m[0]))
      .map((m) => ({ name: m[1], rarity: Number(m[2]) }));
    expect(defs.length).toBeGreaterThanOrEqual(20);
    expect(DEMO_CARS.map((c) => c.name).sort()).toEqual(defs.map((d) => d.name).sort());
    for (const d of defs) expect(DEMO_CARS.find((c) => c.name === d.name)!.rarity).toBe(d.rarity);
  });

  it("points every demo car at a real baked card", async () => {
    const nodeFs = "node:fs";
    const nodeUrl = "node:url";
    const { readdirSync } = await import(nodeFs);
    const { fileURLToPath } = await import(nodeUrl);
    const cards = readdirSync(fileURLToPath(new URL("../../public/cards/", import.meta.url)));
    for (const c of DEMO_CARS) expect(cards).toContain(c.card.replace("/cards/", ""));
  });

  it("rolls with the real tier odds", () => {
    expect(rollDemo(0.99, 0.5)!.rarity).toBe(5);
    expect(rollDemo(0.10, 0.5)!.rarity).toBe(1);
  });
});
