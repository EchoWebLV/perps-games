// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrateCinematic, SHAKE_EXTRA_MS } from "./crate-cinematic";
import { tierOf } from "../core/rarity";

describe("crate-cinematic", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

  const boot = () => {
    const onDone = vi.fn();
    const cx = createCrateCinematic({ onDone });
    document.body.appendChild(cx.el);
    return { cx, onDone };
  };

  it("plays drop-in → shake → rip → flip → chips → done for a legendary", () => {
    const { cx, onDone } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    const crate = cx.el.querySelector(".ccx-crate")!;
    expect(cx.el.classList.contains("ccx-on")).toBe(true);
    expect(crate.classList.contains("drop-in")).toBe(true);
    vi.advanceTimersByTime(500);
    expect(crate.classList.contains("shake")).toBe(true);

    const onCardSlot = vi.fn();
    run.reveal({ rarity: 5, onCardSlot, chips: [{ label: "+800 SCRAP" }] });
    expect(crate.classList.contains("shake-r5")).toBe(true);
    vi.advanceTimersByTime(SHAKE_EXTRA_MS[5]);
    expect(crate.classList.contains("gone")).toBe(true);
    expect(cx.el.querySelector(".ccx-flash")!.classList.contains("go")).toBe(true);
    vi.advanceTimersByTime(230);
    expect(onCardSlot).toHaveBeenCalledOnce();
    expect(cx.el.querySelector(".ccx-card")!.classList.contains("flip-in")).toBe(true);
    vi.advanceTimersByTime(90);
    expect(cx.el.querySelectorAll(".ccx-chip.in").length).toBe(1);

    (cx.el.querySelector(".ccx-done") as HTMLButtonElement).click();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("loops the shake until reveal (VRF wait) and aborts cleanly", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#c3ccd8", loop: true });
    vi.advanceTimersByTime(500);
    expect(cx.el.querySelector(".ccx-crate")!.classList.contains("shakeloop")).toBe(true);
    run.abort();
    expect(cx.el.classList.contains("ccx-on")).toBe(false);
  });

  it("commons rip fast, legendaries slow-burn", () => {
    expect(SHAKE_EXTRA_MS[1]).toBeLessThan(SHAKE_EXTRA_MS[5]);
  });

  it("hides its own Done button in game mode and never fires onDone itself", () => {
    const { cx, onDone } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 3, onCardSlot: () => {}, hideDone: true, chips: [{ label: "+250 SCRAP" }] });
    vi.runAllTimers();
    const done = cx.el.querySelector(".ccx-done") as HTMLButtonElement;
    expect(done.hidden).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("labels the Done button with doneLabel when supplied", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 2, onCardSlot: () => {}, doneLabel: "Collect" });
    vi.runAllTimers();
    const done = cx.el.querySelector(".ccx-done") as HTMLButtonElement;
    expect(done.hidden).toBe(false);
    expect(done.textContent).toBe("Collect");
  });

  it("ignores a second reveal — onCardSlot still runs exactly once", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    const first = vi.fn();
    const second = vi.fn();
    run.reveal({ rarity: 3, onCardSlot: first });
    run.reveal({ rarity: 5, onCardSlot: second }); // no-op
    vi.runAllTimers();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    // the first reveal's tier color wins on the card
    expect((cx.el.querySelector(".ccx-card") as HTMLElement).style.getPropertyValue("--tc")).toBe(tierOf(3).color);
  });

  it("aborts the previous run when open() is called again (fresh node, dead timers)", () => {
    const { cx } = boot();
    cx.open({ crateColor: "#ffd166" });
    const first = cx.el.querySelector(".ccx-crate")!;
    cx.open({ crateColor: "#c3ccd8" }); // implicit abort of the first run
    const second = cx.el.querySelector(".ccx-crate")!;
    expect(second).not.toBe(first);
    expect(cx.el.querySelectorAll(".ccx-crate").length).toBe(1);
    vi.advanceTimersByTime(500);
    expect(second.classList.contains("shake")).toBe(true);
    expect(first.classList.contains("shake")).toBe(false); // stale timer never fired
  });

  it("colors a chip from its own color when provided", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 4, onCardSlot: () => {}, chips: [{ label: "⛓ MagicBlock VRF", color: "#41d67f" }] });
    vi.runAllTimers();
    const chip = cx.el.querySelector(".ccx-chip") as HTMLElement;
    expect(chip.textContent).toBe("⛓ MagicBlock VRF");
    expect(chip.style.getPropertyValue("--tc")).toBe("#41d67f");
  });

  it("paints the card frame with the rolled tier color", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 5, onCardSlot: () => {} });
    vi.advanceTimersByTime(SHAKE_EXTRA_MS[5] + 230);
    expect((cx.el.querySelector(".ccx-card") as HTMLElement).style.getPropertyValue("--tc")).toBe(tierOf(5).color);
  });

  it("bumps the rip flash only for epic-and-up pulls", () => {
    const big = boot().cx;
    const bigRun = big.open({ crateColor: "#ffd166" });
    vi.advanceTimersByTime(500);
    bigRun.reveal({ rarity: 4, onCardSlot: () => {} });
    vi.advanceTimersByTime(SHAKE_EXTRA_MS[4]);
    expect((big.el.querySelector(".ccx-flash") as HTMLElement).style.transform).toBe("scale(1.5)");

    document.body.innerHTML = "";
    const small = boot().cx;
    const smallRun = small.open({ crateColor: "#3ba7ff" });
    vi.advanceTimersByTime(500);
    smallRun.reveal({ rarity: 3, onCardSlot: () => {} });
    vi.advanceTimersByTime(SHAKE_EXTRA_MS[3]);
    expect((small.el.querySelector(".ccx-flash") as HTMLElement).style.transform).toBe("");
  });

  it("collapses the escalation wait to 0ms in low-tier mode", () => {
    const onDone = vi.fn();
    const cx = createCrateCinematic({ lowTier: true, onDone });
    document.body.appendChild(cx.el);
    const run = cx.open({ crateColor: "#ffd166" });
    const crate = cx.el.querySelector(".ccx-crate")!;
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 5, onCardSlot: () => {} });
    vi.advanceTimersByTime(0); // escalation is instant, no slow-burn
    expect(crate.classList.contains("gone")).toBe(true);
  });

  it("honors OS reduced-motion by skipping the escalation wait", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { cx } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    const crate = cx.el.querySelector(".ccx-crate")!;
    vi.advanceTimersByTime(500);
    run.reveal({ rarity: 5, onCardSlot: () => {} });
    vi.advanceTimersByTime(0);
    expect(crate.classList.contains("gone")).toBe(true);
  });

  it("renders an <img> crate when a crate image url is given", () => {
    const { cx } = boot();
    cx.open({ crateImgUrl: "/models/crate.png", crateColor: "#ffd166" });
    const crate = cx.el.querySelector(".ccx-crate")!;
    expect(crate.tagName).toBe("IMG");
    expect((crate as HTMLImageElement).getAttribute("src")).toBe("/models/crate.png");
  });

  it("dispose() tears the overlay out of the DOM", () => {
    const { cx } = boot();
    cx.open({ crateColor: "#ffd166" });
    expect(document.body.contains(cx.el)).toBe(true);
    cx.dispose();
    expect(document.body.contains(cx.el)).toBe(false);
  });
});
