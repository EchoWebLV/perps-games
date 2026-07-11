// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHud } from "./hud";

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
