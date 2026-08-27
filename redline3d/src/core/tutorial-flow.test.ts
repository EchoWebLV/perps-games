import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("keeps how-to scoped for the menu, but the hub boot is not gated by it", async () => {
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const start = main.indexOf("function maybeShowHowTo");
  const end = main.indexOf("\n}\n", start) + 2;
  const helper = main.slice(start, end);

  expect(helper).toContain("namespace?: string");
  expect(helper).toContain("howToSeen(browserStore, namespace)");
  expect(helper).toContain("markHowToSeen(browserStore, namespace)");
  // Hub is the front door — no blocking how-to / access wall on boot.
  expect(main).not.toContain("maybeShowHowTo(() => maybeWelcomeGift())");
  expect(main).not.toContain("maybeShowHowTo(() => { void offerWelcomeAccount(); }, session.address());");
  expect(main).toContain("if (freshVisitor) maybeWelcomeGift()");
  expect(main).toContain("void offerWelcomeAccount()");
  expect(main).toContain('hudRoot.addEventListener("raider:howto"');
});
