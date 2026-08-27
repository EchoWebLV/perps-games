import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("hub boot: Race is Perps Track, Grand Prix is unwired, access wall is not the front door", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  expect(main).toContain("onRace: () => enterRaceFromHub()");
  expect(main).toContain("onLobby: () => exitHomeToLobby()");
  expect(main).not.toContain("onEnterRace:");
  expect(main).not.toContain("onWatchAndBet:");
  expect(main).toContain("function enterRaceFromHub()");
  expect(main).toContain("function returnToHub()");
  // Grand Prix code stays for a later unhide — just not entered from the hub.
  expect(main).toContain("function enterGrandprix");
  expect(main).toContain("function bootIdentity()");
  expect(main).toContain('identity = { name: "guest", mode: "guest" }');
  expect(main).not.toMatch(/function bootIdentity\(\) \{\s*if \(!identity\) \{ showIdentityGate\(\)/);
});
