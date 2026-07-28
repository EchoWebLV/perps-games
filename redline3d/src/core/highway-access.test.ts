import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { highwayAvailable, highwayEntryDecision } from "./highway-access";

describe("highwayAvailable", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("allows loopback host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(true);
  });

  it.each(["redline-web-production.up.railway.app", "perps.example.com", ""])("blocks public host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(false);
  });

  it("prioritizes the public gate, then requires a confirmed local driver name", () => {
    expect(highwayEntryDecision("redline-web-production.up.railway.app", false)).toBe("coming-soon");
    expect(highwayEntryDecision("localhost", false)).toBe("driver-name");
    expect(highwayEntryDecision("localhost", true)).toBe("enter");
  });

  it("keeps Highway closed in native builds that use localhost as their app origin", () => {
    expect(highwayEntryDecision("localhost", false, true)).toBe("coming-soon");
    expect(highwayEntryDecision("localhost", true, true)).toBe("coming-soon");
  });

  it("keeps the Highway out of the plaza: RACE opens the book, TRACK is the perps ring", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");

    // the anchor building opens the chain-book grandprix with the equipped car on the grid
    expect(main).toContain('case "race": enterGrandprix(equippedCar.name);');
    // TRACK is what it always was — the perps ring, full racing HUD, GO lives there
    expect(main).toContain('case "track": exitFrom = "track"; exitLobby();');
    // the Highway has no storefront left, so no door can reach it and nothing needs gating.
    // The MODE survives: the boot-restore of an open position calls enterHighway(true) directly.
    expect(main).not.toContain('case "highway"');
    expect(main).toContain("enterHighway(true)");
  });
});
