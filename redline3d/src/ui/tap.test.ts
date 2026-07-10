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
});
