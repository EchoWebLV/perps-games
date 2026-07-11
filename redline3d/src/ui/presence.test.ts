import { afterEach, describe, expect, test, vi } from "vitest";
import { createPresenceHud } from "./presence";

class FakeElement {
  tag: string;
  className = "";
  textContent = "";
  style: Record<string, string> = { cssText: "" };
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  onclick: (() => void) | null = null;
  listeners: Record<string, Array<(event: Record<string, unknown>) => void>> = {};

  constructor(tag = "div") { this.tag = tag; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  addEventListener(type: string, fn: (event: Record<string, unknown>) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, ...event });
  }
  querySelector(selector: string): FakeElement | null {
    const dataKey = selector.slice(1, -1).replace(/^data-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const match = (element: FakeElement) => selector.startsWith("[")
      ? element.dataset[dataKey] !== undefined
      : element.tag === selector;
    const walk = (element: FakeElement): FakeElement | null => {
      for (const child of element.children) {
        if (match(child)) return child;
        const result = walk(child);
        if (result) return result;
      }
      return null;
    };
    return walk(this);
  }
}

function installFakeDocument() {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
}

function installFakeWindow() {
  const listeners: Array<{
    type: string;
    fn: (event: Record<string, unknown>) => void;
    options?: { once?: boolean };
  }> = [];
  const fakeWindow = {
    addEventListener(type: string, fn: (event: Record<string, unknown>) => void, options?: { once?: boolean }) {
      listeners.push({ type, fn, options });
    },
    removeEventListener(type: string, fn: (event: Record<string, unknown>) => void) {
      const index = listeners.findIndex((listener) => listener.type === type && listener.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatchRetargetedClick(target: FakeElement) {
      let stopped = false;
      const event = {
        stopPropagation: () => { stopped = true; },
        preventDefault: vi.fn(),
      };
      for (const listener of [...listeners]) {
        if (listener.type !== "click") continue;
        listener.fn(event);
        if (listener.options?.once) fakeWindow.removeEventListener(listener.type, listener.fn);
      }
      if (!stopped) target.fire("click", event);
    },
  };
  vi.stubGlobal("window", fakeWindow);
  return fakeWindow;
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("createPresenceHud", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("is hidden outside the lobby and follows explicit visibility", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    const root = parent.children[0];

    expect(root.style.display).toBe("none");
    hud.setVisible(true);
    expect(root.style.display).toBe("flex");
    hud.setVisible(false);
    expect(root.style.display).toBe("none");
  });

  test("shows LIVE 2 and dispatches the single spark button once", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const onEmote = vi.fn();
    const hud = createPresenceHud(parent as never, onEmote);
    const root = parent.children[0];

    hud.setVisible(true);
    hud.setState("live", 2);

    expect(root.querySelector("[data-live-count]")?.textContent).toBe("LIVE 2");
    const button = root.querySelector("[data-live-emote]")!;
    expect(button.tag).toBe("button");
    expect(button.textContent).toBe("⚡");
    expect(root.children.filter((child) => child.tag === "button")).toHaveLength(1);
    button.fire("click");
    expect(onEmote).toHaveBeenCalledTimes(1);
  });

  test("fires a non-primary tap once and swallows its retargeted synthetic click", () => {
    vi.useFakeTimers();
    installFakeDocument();
    const fakeWindow = installFakeWindow();
    const parent = new FakeElement();
    const onEmote = vi.fn();
    createPresenceHud(parent as never, onEmote);
    const button = parent.children[0].querySelector("[data-live-emote]")!;

    button.fire("pointerdown", { pointerId: 7, isPrimary: false });
    button.fire("pointerup", { pointerId: 7, isPrimary: false });
    expect(onEmote).toHaveBeenCalledTimes(1);

    const retarget = new FakeElement("button");
    retarget.addEventListener("click", onEmote);
    fakeWindow.dispatchRetargetedClick(retarget);
    expect(onEmote).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
  });

  test("renders offline and connecting states", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    const count = parent.children[0].querySelector("[data-live-count]")!;

    hud.setState("offline", 8);
    expect(count.textContent).toBe("LIVE OFFLINE");
    hud.setState("connecting", 8);
    expect(count.textContent).toBe("CONNECTING");
  });

  test("announces changing presence as an atomic polite status", () => {
    installFakeDocument();
    const parent = new FakeElement();
    createPresenceHud(parent as never, vi.fn());
    const count = parent.children[0].querySelector("[data-live-count]")!;

    expect(count.attrs.role).toBe("status");
    expect(count.attrs["aria-live"]).toBe("polite");
    expect(count.attrs["aria-atomic"]).toBe("true");
  });

  test("keeps the overlay inert except for its safe-area spark button", () => {
    installFakeDocument();
    const parent = new FakeElement();
    createPresenceHud(parent as never, vi.fn());
    const root = parent.children[0];
    const button = root.querySelector("[data-live-emote]")!;

    expect(root.style.cssText).toContain("env(safe-area-inset-top)");
    expect(root.style.cssText).toContain("env(safe-area-inset-right)");
    expect(root.style.cssText).toContain("pointer-events:none");
    expect(button.style.cssText).toContain("pointer-events:auto");
    expect(descendants(root).filter((element) => element.style.cssText.includes("pointer-events:auto"))).toEqual([button]);
  });

  test("pulses locally and settles back", () => {
    vi.useFakeTimers();
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    const button = parent.children[0].querySelector("[data-live-emote]")!;

    hud.pulse();
    expect(button.style.transform).toBe("scale(1.18)");
    vi.runAllTimers();
    expect(button.style.transform).toBe("scale(1)");
  });
});
