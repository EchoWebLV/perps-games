// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDemoCrate } from "./demo-crate";
import { SHAKE_EXTRA_MS } from "../ui/crate-cinematic";

// This file is jsdom (the sibling demo-crate.test.ts stays node so it can readdir public/cards/).

// Enough to clear every cinematic phase for any rarity: the pre-reveal pause (900) + the longest
// rarity dwell + the white flash (230) + one chip's stagger (90) + slack. Timers are faked, so we
// just step past it deterministically.
const FULL_RUN_MS = 900 + Math.max(...Object.values(SHAKE_EXTRA_MS)) + 230 + 90 + 250;

function mountCrackSection(): HTMLButtonElement {
  document.body.innerHTML = `
    <section id="crack" data-demo-crate>
      <button type="button" data-demo-open><span>Crack a crate</span><b aria-hidden="true">RIP</b></button>
    </section>
  `;
  return document.querySelector<HTMLButtonElement>("[data-demo-open]")!;
}

describe("demo crate DOM wiring", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic roll (feeds both rTier and rCar)
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("cracks a crate into a card face and returns focus to the trigger on close", () => {
    const button = mountCrackSection();
    initDemoCrate();

    const overlay = document.querySelector<HTMLElement>("[data-demo-crate] .ccx-root")!;
    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains("ccx-on")).toBe(false); // nothing until the visitor cracks it

    button.click();
    expect(overlay.classList.contains("ccx-on")).toBe(true);

    vi.advanceTimersByTime(FULL_RUN_MS);

    const art = overlay.querySelector<HTMLImageElement>("img.demo-card-art");
    expect(art).toBeTruthy();
    expect(art!.getAttribute("alt")).toBeTruthy();                // labeled for SR users
    expect(art!.getAttribute("src")).toMatch(/^\/cards\/.+\.png$/); // a real baked card path
    expect(overlay.querySelector(".demo-keep")).toBeTruthy();       // the "play to keep" CTA

    const done = overlay.querySelector<HTMLButtonElement>(".ccx-done")!;
    expect(done.hidden).toBe(false);
    expect(done.textContent).toBe("Crack another");

    done.click(); // "Crack another" tears the overlay down and hands focus back to the trigger
    expect(overlay.classList.contains("ccx-on")).toBe(false);
    expect(document.activeElement).toBe(button); // pins the focus-return fix
  });
});
