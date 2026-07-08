// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { createFpsMeter } from "./fpsmeter";

// Drive the meter with synthetic rAF timestamps — no timers, no real frames.
const FRAME_60 = 1000 / 60;

function feed(meter: { tick(now: number): void }, start: number, frames: number, dtMs: number): number {
  let t = start;
  for (let i = 0; i < frames; i++) {
    t += dtMs;
    meter.tick(t);
  }
  return t;
}

describe("createFpsMeter", () => {
  test("disabled (no ?fps flag): no DOM at all, tick is a no-op, fps stays 0", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { search: "" });
    expect(meter.el).toBeUndefined();
    expect(parent.children.length).toBe(0);
    feed(meter, 0, 10, FRAME_60);
    expect(meter.fps()).toBe(0);
  });

  test("explicit enabled:false wins even when the flag is present", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { enabled: false, search: "?fps" });
    expect(meter.el).toBeUndefined();
    expect(parent.children.length).toBe(0);
  });

  test("?fps in the search string mounts the chip (other params may coexist)", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { search: "?fps&perf=low" });
    expect(meter.el).toBeDefined();
    expect(parent.children.length).toBe(1);
    expect(meter.el!.getAttribute("aria-label")).toBe("Frames per second");
  });

  // Build-time pin for the APK, whose WebView has no address bar to carry `?fps` on-device.
  test("VITE_FPS truthy env mounts the chip when no ?fps param is present", () => {
    for (const v of ["1", "true"]) {
      const parent = document.createElement("div");
      const meter = createFpsMeter(parent, { search: "", envFps: v });
      expect(meter.el).toBeDefined();
      expect(parent.children.length).toBe(1);
    }
    // falsy / non-truthy / empty env stays disabled (explicit injected env isolates the real one)
    expect(createFpsMeter(document.createElement("div"), { search: "", envFps: "0" }).el).toBeUndefined();
    expect(createFpsMeter(document.createElement("div"), { search: "", envFps: "" }).el).toBeUndefined();
  });

  test("a present ?fps param beats the env (enables even when VITE_FPS is falsy)", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { search: "?fps", envFps: "0" });
    expect(meter.el).toBeDefined();
    expect(parent.children.length).toBe(1);
  });

  test("explicit enabled:false still wins over both the ?fps flag and the VITE_FPS env", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { enabled: false, search: "?fps", envFps: "1" });
    expect(meter.el).toBeUndefined();
    expect(parent.children.length).toBe(0);
  });

  test("EMA converges to a steady frame rate", () => {
    const meter = createFpsMeter(document.createElement("div"), { enabled: true });
    expect(meter.fps()).toBe(0); // no samples yet
    meter.tick(0); // primes the previous-timestamp; still no interval
    expect(meter.fps()).toBe(0);
    feed(meter, 0, 120, FRAME_60);
    expect(meter.fps()).toBeCloseTo(60, 0);
  });

  test("EMA follows a rate change (60 → 30 fps)", () => {
    const meter = createFpsMeter(document.createElement("div"), { enabled: true });
    meter.tick(0);
    const t = feed(meter, 0, 120, FRAME_60);
    feed(meter, t, 200, 1000 / 30);
    expect(meter.fps()).toBeCloseTo(30, 0);
  });

  test("dt<=0 is ignored (duplicate or backwards timestamps)", () => {
    const meter = createFpsMeter(document.createElement("div"), { enabled: true });
    meter.tick(0);
    const t = feed(meter, 0, 60, FRAME_60);
    const before = meter.fps();
    meter.tick(t); // dt = 0
    meter.tick(t - 5); // dt < 0
    expect(meter.fps()).toBe(before);
    expect(Number.isFinite(meter.fps())).toBe(true);
  });

  test("gaps over 1s are ignored (tab-switch guard), then measurement resumes cleanly", () => {
    const meter = createFpsMeter(document.createElement("div"), { enabled: true });
    meter.tick(0);
    const t = feed(meter, 0, 120, FRAME_60);
    expect(meter.fps()).toBeCloseTo(60, 0);
    meter.tick(t + 5000); // backgrounded tab — a 5s frame must not drag the EMA toward 0.2fps
    expect(meter.fps()).toBeCloseTo(60, 0);
    feed(meter, t + 5000, 30, FRAME_60); // resumes from the new baseline
    expect(meter.fps()).toBeCloseTo(60, 0);
  });

  test("DOM chip updates at most ~4x/sec, not every frame", () => {
    const parent = document.createElement("div");
    const meter = createFpsMeter(parent, { enabled: true });
    const num = meter.el!.querySelector(".num") as HTMLElement;
    expect(num.textContent).toBe("—"); // no samples yet

    meter.tick(0);
    meter.tick(FRAME_60); // first sample draws immediately
    expect(num.textContent).toBe("60");

    // speed up to 120fps within the 250ms window — the text must NOT chase it yet
    const t = feed(meter, FRAME_60, 20, 1000 / 120);
    expect(num.textContent).toBe("60");
    expect(meter.fps()).toBeGreaterThan(60); // ...even though the EMA already moved

    // crossing the 250ms window redraws with the EMA as of that tick
    feed(meter, t, 30, 1000 / 120);
    expect(num.textContent).not.toBe("60");
    expect(Number(num.textContent)).toBeGreaterThan(100);
  });
});
