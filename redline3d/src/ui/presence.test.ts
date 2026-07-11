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
    const status = parent.querySelector("[data-presence-status]")!;
    const rail = parent.querySelector("[data-presence-emotes]")!;

    expect(status.style.display).toBe("none");
    expect(rail.style.display).toBe("none");
    hud.setVisible(true);
    expect(status.style.display).toBe("block");
    expect(rail.style.display).toBe("flex");
    hud.setVisible(false);
    expect(status.style.display).toBe("none");
    expect(rail.style.display).toBe("none");
  });

  test("centers LIVE 3 independently from the right-side emote rail", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    hud.setVisible(true);
    hud.setState("live", 3);
    const status = parent.querySelector("[data-presence-status]")!;
    const rail = parent.querySelector("[data-presence-emotes]")!;

    expect(status.textContent).toBe("LIVE 3");
    expect(status.style.cssText).toContain("left:50%");
    expect(status.style.cssText).toContain("translateX(-50%)");
    expect(rail.style.cssText).toContain("right:max(12px,env(safe-area-inset-right))");
  });

  test("dispatches laugh, fire, and skull from three ordered buttons", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const sent: string[] = [];
    createPresenceHud(parent as never, (kind) => sent.push(kind));
    const rail = parent.querySelector("[data-presence-emotes]")!;
    const buttons = rail.children.filter((child) => child.tag === "button");

    expect(buttons.map(({ textContent }) => textContent)).toEqual(["😂", "🔥", "💀"]);
    buttons.forEach((button) => button.fire("click"));
    expect(sent).toEqual(["laugh", "fire", "skull"]);
    expect(buttons.map((button) => button.attrs["aria-label"])).toEqual([
      "Send laugh emote", "Send fire emote", "Send skull emote",
    ]);
  });

  test("fires a non-primary tap once and swallows its retargeted synthetic click", () => {
    vi.useFakeTimers();
    installFakeDocument();
    const fakeWindow = installFakeWindow();
    const parent = new FakeElement();
    const onEmote = vi.fn();
    createPresenceHud(parent as never, onEmote);
    const button = parent.querySelector("[data-live-emote]")!;

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
    const status = parent.querySelector("[data-presence-status]")!;

    hud.setState("offline", 8);
    expect(status.textContent).toBe("LIVE OFFLINE");
    hud.setState("connecting", 8);
    expect(status.textContent).toBe("CONNECTING");
  });

  test("announces changing presence as an atomic polite status", () => {
    installFakeDocument();
    const parent = new FakeElement();
    createPresenceHud(parent as never, vi.fn());
    const status = parent.querySelector("[data-presence-status]")!;

    expect(status.attrs.role).toBe("status");
    expect(status.attrs["aria-live"]).toBe("polite");
    expect(status.attrs["aria-atomic"]).toBe("true");
  });

  test("keeps the overlays inert except for exactly three safe-area emote buttons", () => {
    installFakeDocument();
    const parent = new FakeElement();
    createPresenceHud(parent as never, vi.fn());
    const status = parent.querySelector("[data-presence-status]")!;
    const rail = parent.querySelector("[data-presence-emotes]")!;
    const buttons = rail.children.filter((child) => child.tag === "button");

    expect(status.style.cssText).toContain("env(safe-area-inset-top)");
    expect(rail.style.cssText).toContain("env(safe-area-inset-right)");
    expect(status.style.cssText).toContain("pointer-events:none");
    expect(rail.style.cssText).toContain("pointer-events:none");
    expect(descendants(parent).filter((element) => element.style.cssText.includes("pointer-events:auto"))).toEqual(buttons);
    expect(buttons).toHaveLength(3);
  });

  test("pulses the selected emote locally and settles back", () => {
    vi.useFakeTimers();
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    const rail = parent.querySelector("[data-presence-emotes]")!;
    const buttons = rail.children.filter((child) => child.tag === "button");
    const fire = buttons[1];

    hud.pulse("fire");
    expect(fire.style.transform).toBe("scale(1.18)");
    expect(buttons[0].style.transform).toBe("scale(1)");
    expect(buttons[2].style.transform).toBe("scale(1)");
    vi.runAllTimers();
    expect(fire.style.transform).toBe("scale(1)");
  });
});
