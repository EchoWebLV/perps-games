import { describe, expect, test } from "vitest";
import { setHudMenuMode } from "./carpicker";

function fakeEl() {
  return { style: { display: "" } } as HTMLElement;
}

function fakeParent(children: HTMLElement[]) {
  return { children } as unknown as HTMLElement;
}

describe("setHudMenuMode", () => {
  test("hides every hud child except the menu root while menu is open", () => {
    const bal = fakeEl();
    const menu = fakeEl();
    const dock = fakeEl();
    const parent = fakeParent([bal, menu, dock]);

    setHudMenuMode(parent, menu, true);

    expect(bal.style.display).toBe("none");
    expect(menu.style.display).toBe("");
    expect(dock.style.display).toBe("none");
  });

  test("restores hud children when the menu closes", () => {
    const bal = fakeEl();
    const menu = fakeEl();
    const dock = fakeEl();
    const parent = fakeParent([bal, menu, dock]);

    setHudMenuMode(parent, menu, true);
    setHudMenuMode(parent, menu, false);

    expect(bal.style.display).toBe("");
    expect(menu.style.display).toBe("");
    expect(dock.style.display).toBe("");
  });
});
