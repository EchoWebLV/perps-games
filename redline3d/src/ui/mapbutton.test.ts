import { afterEach, describe, expect, test, vi } from "vitest";
import { createMapButton } from "./mapbutton";

// The repo has no jsdom; UI is tested against a minimal hand-rolled DOM stub
// (same approach as coins.test.ts). Handlers are invoked directly via `.onclick`.
class FakeElement {
  tag: string;
  type = "";
  className = "";
  innerHTML = "";
  textContent = "";
  style: Record<string, string> = { cssText: "" };
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  onclick: (() => void) | null = null;
  constructor(tag = "div") { this.tag = tag; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  appendChild(c: FakeElement) { this.children.push(c); return c; }
  querySelector(sel: string): FakeElement | null {
    const match = (e: FakeElement) =>
      sel.startsWith("[") ? e.dataset[sel.slice(1, -1).replace(/^data-/, "")] !== undefined : e.tag === sel;
    const walk = (e: FakeElement): FakeElement | null => {
      for (const c of e.children) { if (match(c)) return c; const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(this);
  }
}

function installFakeDocument() {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
}

describe("createMapButton", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("creates a button, fires onClick, and toggles visibility", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const onClick = vi.fn();

    const mb = createMapButton(parent as unknown as HTMLElement, onClick);
    const btn = parent.querySelector("button")!;
    expect(btn).toBeTruthy();
    expect(btn.attrs["aria-label"]).toBe("Open garage lobby");
    // the pill is text-only — just the "LOBBY" wordmark, no icon
    expect(btn.innerHTML).toContain("LOBBY");
    expect(btn.innerHTML).not.toContain("<svg");

    btn.onclick!();
    expect(onClick).toHaveBeenCalledOnce();

    mb.setVisible(false);
    expect((mb.el as unknown as FakeElement).style.display).toBe("none");
    mb.setVisible(true);
    expect((mb.el as unknown as FakeElement).style.display).toBe("inline-flex");
  });
});
