import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("scopes automatic signed-in tutorials to the wallet while leaving guests device-local", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const start = main.indexOf("function maybeShowHowTo");
  const end = main.indexOf("\n}\n", start) + 2;
  const helper = main.slice(start, end);

  expect(helper).toContain("namespace?: string");
  expect(helper).toContain("howToSeen(browserStore, namespace)");
  expect(helper).toContain("markHowToSeen(browserStore, namespace)");
  expect(main).toContain("maybeShowHowTo(() => maybeWelcomeGift())");
  const accountTutorialCall = "maybeShowHowTo(() => { void offerWelcomeAccount(); }, session.address());";
  expect(main.split(accountTutorialCall)).toHaveLength(3);
});
