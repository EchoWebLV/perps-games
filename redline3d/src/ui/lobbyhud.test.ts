import { afterEach, describe, expect, test, vi } from "vitest";
import { createLobbyHud } from "./lobbyhud";

// The repo has no jsdom; UI is tested against a minimal hand-rolled DOM stub
// (same approach as coins.test.ts). Handlers are invoked directly via `.onclick`.
class FakeElement {
  tag: string;
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

describe("createLobbyHud", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("hides by default, shows on show(), and fires onExit", () => {
    installFakeDocument();
    const parent = new FakeElement();
    const onExit = vi.fn();

    const hud = createLobbyHud(parent as unknown as HTMLElement, onExit);
    const el = hud.el as unknown as FakeElement;
    expect(el.style.display).toBe("none");

    hud.show();
    expect(el.style.display).toBe("block");

    el.querySelector("[data-exit]")!.onclick!();
    expect(onExit).toHaveBeenCalledOnce();
  });

  test("shows the prompt for an asset and clears it on null", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement, () => {});
    const prompt = (hud.el as unknown as FakeElement).querySelector("[data-prompt]")!;

    hud.setPrompt("SOL");
    expect(prompt.style.opacity).toBe("1");
    expect(prompt.textContent).toContain("SOLANA");

    hud.setPrompt(null);
    expect(prompt.style.opacity).toBe("0");
  });
});
