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

  it("gates only the Highway building branch", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf('case "highway"');
    const end = main.indexOf("\n  }", start);
    const branch = main.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain("highwayEntryDecision");
    expect(branch).toContain("capacitorNative");
    expect(branch).toContain('lobbyHud.toast("Highway coming soon")');
    expect(branch).toContain("openDriverNameDialog(true, enterHighwayFromLobby)");
    expect(main).toContain('case "track": exitFrom = "track"; exitLobby();');
  });
});
