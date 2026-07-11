// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHud } from "./hud";
import { createHighwayControls } from "./highway-controls";

describe("HUD open-ended position timer", () => {
  it("shows OPEN instead of a countdown for an open-ended position", () => {
    const mount = document.createElement("div");
    const hud = createHud(mount);
    hud.setOpenPosition(true);
    hud.setTimer(12, true);
    expect(mount.querySelector("#timer")?.textContent).toBe("OPEN");
  });

  it("returns to the normal countdown after the position closes", () => {
    const mount = document.createElement("div");
    const hud = createHud(mount);
    hud.setOpenPosition(true);
    hud.setOpenPosition(false);
    hud.setTimer(60, false);
    expect(mount.querySelector("#timer")?.textContent).toBe("1:00");
  });
});

describe("Highway control placement", () => {
  it("keeps the leverage slider inside the dock flow and interactive", () => {
    const mount = document.createElement("div");
    const hud = createHud(mount);
    const commits: number[] = [];
    const controls = createHighwayControls(hud.highwayMount, { onCommit: (lev) => commits.push(lev) });
    controls.show();
    const panel = hud.highwayMount.querySelector("section") as HTMLElement;
    const slider = panel.querySelector("input") as HTMLInputElement;
    expect(panel.style.position).toBe("relative");
    expect(panel.style.bottom).toBe("");
    slider.value = "250";
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
    expect(commits).toEqual([250]);
  });
});
