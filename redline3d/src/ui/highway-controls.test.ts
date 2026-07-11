// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHighwayControls } from "./highway-controls";

describe("Highway leverage controls", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("previews during input and commits once on change", () => {
    const commits: number[] = [];
    const controls = createHighwayControls(document.body, { onCommit: (lev) => commits.push(lev) });
    controls.show();
    const slider = document.querySelector<HTMLInputElement>("[data-highway-leverage]")!;
    slider.value = "146";
    slider.dispatchEvent(new Event("input"));
    expect(document.body.textContent).toContain("150x");
    expect(commits).toEqual([]);
    slider.dispatchEvent(new Event("change"));
    slider.dispatchEvent(new Event("pointerup"));
    expect(commits).toEqual([150]);
  });

  it("shows requested and confirmed values while syncing", () => {
    const controls = createHighwayControls(document.body, { onCommit: vi.fn() });
    controls.setConfirmed(100);
    controls.setSyncing(250);
    expect(document.body.textContent).toContain("250x");
    expect(document.body.textContent).toContain("CONFIRMED 100x");
    expect(document.body.textContent).toContain("SYNCING");
    controls.setConfirmed(250);
    expect(document.body.textContent).not.toContain("SYNCING");
  });

  it("renders verified sentiment and exposes an accessible 10x to 250x slider", () => {
    const controls = createHighwayControls(document.body, { onCommit: vi.fn() });
    controls.setSentiment(12, 8, 140);
    const slider = document.querySelector<HTMLInputElement>("[data-highway-leverage]")!;
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("250");
    expect(slider.step).toBe("10");
    expect(slider.getAttribute("aria-label")).toBe("Highway leverage");
    expect(document.body.textContent).toContain("LONG 12");
    expect(document.body.textContent).toContain("SHORT 8");
    expect(document.body.textContent).toContain("AVG 140x");
  });
});
