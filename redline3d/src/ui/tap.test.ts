import { describe, expect, test, vi } from "vitest";
import { onTap } from "./tap";

// No jsdom in this project — UI is tested against a minimal hand-rolled DOM stub
// (same approach as mapbutton.test.ts). onTap only calls el.addEventListener, so the
// fake stores listeners per type and exposes fire()/click() to dispatch them. click()
// mirrors real DOM: it fires registered "click" listeners AND the onclick property.
class FakeElement {
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  onclick: ((e: unknown) => void) | null = null;
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, ...e });
  }
  click() {
    this.fire("click");
    this.onclick?.({ type: "click" });
  }
}
const mk = () => new FakeElement();

describe("onTap (any-finger tap — a second finger fires while the first holds the gas)", () => {
  test("a non-primary second finger (pointerId 7) fires on down+up", () => {
    const el = mk();
    const fn = vi.fn();
    onTap(el as unknown as HTMLElement, fn);
    el.fire("pointerdown", { pointerId: 7, isPrimary: false });
    el.fire("pointerup", { pointerId: 7, isPrimary: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a pointerup whose id never went down on the element does not fire", () => {
    const el = mk();
    const fn = vi.fn();
    onTap(el as unknown as HTMLElement, fn);
    el.fire("pointerup", { pointerId: 3 }); // finger lifted here but pressed elsewhere
    expect(fn).not.toHaveBeenCalled();
  });

  test("a cancelled press does not fire on the later up (same id)", () => {
    const el = mk();
    const fn = vi.fn();
    onTap(el as unknown as HTMLElement, fn);
    el.fire("pointerdown", { pointerId: 5 });
    el.fire("pointercancel", { pointerId: 5 });
    el.fire("pointerup", { pointerId: 5 });
    expect(fn).not.toHaveBeenCalled();
  });

  test("the synthetic click after our own pointerup is suppressed (fires exactly once)", () => {
    const el = mk();
    const fn = vi.fn();
    onTap(el as unknown as HTMLElement, fn);
    el.fire("pointerdown", { pointerId: 1, isPrimary: true });
    el.fire("pointerup", { pointerId: 1, isPrimary: true });
    el.fire("click"); // the browser's synthetic click for the primary pointer
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a bare click with no prior pointer events still fires (keyboard Enter / test .click())", () => {
    const el = mk();
    const fn = vi.fn();
    onTap(el as unknown as HTMLElement, fn);
    el.click();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // With a real window present (Android WebView / browser) the tap's trailing click can
  // RETARGET to whatever fn put under the finger, so onTap arms a one-shot capture-phase
  // suppressor on window to eat it. The node test env has no window, so we stand up a
  // minimal spy (not a capture-phase emulation) to assert the arming contract + teardown.
  test("a pointer-fire arms a one-shot window capture suppressor that eats the retargeted click", () => {
    vi.useFakeTimers();
    const added: Array<{ type: string; fn: (e: Event) => void; opts: unknown }> = [];
    const removed: Array<(e: Event) => void> = [];
    const fakeWin = {
      addEventListener: (type: string, fn: (e: Event) => void, opts: unknown) => { added.push({ type, fn, opts }); },
      removeEventListener: (_type: string, fn: (e: Event) => void) => { removed.push(fn); },
    };
    (globalThis as unknown as { window: unknown }).window = fakeWin;
    try {
      const el = mk();
      const fn = vi.fn();
      onTap(el as unknown as HTMLElement, fn);
      el.fire("pointerdown", { pointerId: 1, isPrimary: true });
      el.fire("pointerup", { pointerId: 1, isPrimary: true });
      expect(fn).toHaveBeenCalledTimes(1);
      // exactly one suppressor, on "click", registered one-shot in the capture phase
      expect(added).toHaveLength(1);
      expect(added[0].type).toBe("click");
      expect(added[0].opts).toEqual({ capture: true, once: true });
      // the armed handler swallows the (possibly retargeted) click
      const ce = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
      added[0].fn(ce as unknown as Event);
      expect(ce.stopPropagation).toHaveBeenCalledTimes(1);
      expect(ce.preventDefault).toHaveBeenCalledTimes(1);
      // the safety timeout tears the listener back down
      vi.runAllTimers();
      expect(removed).toContain(added[0].fn);
    } finally {
      vi.useRealTimers();
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});
