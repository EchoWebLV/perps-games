import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { highwayAvailable } from "./highway-access";

describe("highwayAvailable", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("allows loopback host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(true);
  });

  it.each(["redline-web-production.up.railway.app", "perps.example.com", ""])("blocks public host %s", (hostname) => {
    expect(highwayAvailable(hostname)).toBe(false);
  });

  it("gates only the Highway building branch", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf('case "highway"');
    const end = main.indexOf("\n  }", start);
    const branch = main.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain("highwayAvailable");
    expect(branch).toContain('lobbyHud.toast("Highway coming soon")');
    expect(main).toContain('case "track": exitFrom = "track"; exitLobby();');
  });
});
