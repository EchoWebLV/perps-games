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
  constructor(tag = "div") { this.tag = tag; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  addEventListener() { /* unused — no emote buttons */ }
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

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("createPresenceHud", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("is hidden outside the lobby and follows explicit visibility", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    const status = parent.querySelector("[data-presence-status]")!;

    expect(status.style.display).toBe("none");
    hud.setVisible(true);
    expect(status.style.display).toBe("block");
    hud.setVisible(false);
    expect(status.style.display).toBe("none");
  });

  test("centers LIVE 3 with no emoji emote rail", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const hud = createPresenceHud(parent as never, vi.fn());
    hud.setVisible(true);
    hud.setState("live", 3);
    const status = parent.querySelector("[data-presence-status]")!;

    expect(status.textContent).toBe("LIVE 3");
    expect(status.style.cssText).toContain("left:50%");
    expect(status.style.cssText).toContain("translateX(-50%)");
    expect(parent.querySelector("[data-presence-emotes]")).toBeNull();
    expect(descendants(parent).some((el) => /😂|🔥|💀/.test(el.textContent))).toBe(false);
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

  test("status overlay stays inert — home is the side control, not emotes", () => {
    installFakeDocument();
    const parent = new FakeElement();
    createPresenceHud(parent as never, vi.fn());
    const status = parent.querySelector("[data-presence-status]")!;

    expect(status.style.cssText).toContain("env(safe-area-inset-top)");
    expect(status.style.cssText).toContain("pointer-events:none");
    expect(descendants(parent).filter((el) => el.tag === "button")).toHaveLength(0);
  });
});
