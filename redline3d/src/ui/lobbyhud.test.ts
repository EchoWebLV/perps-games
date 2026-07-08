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

  test("hides by default, shows on show(), and carries no exit button (the strip is home)", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement);
    const el = hud.el as unknown as FakeElement;
    expect(el.style.display).toBe("none");

    hud.show();
    expect(el.style.display).toBe("block");

    // the strip is the home world now — no "leave the lobby" button, no duplicate driving hint
    expect(el.querySelector("[data-exit]")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });

  test("shows the offer card for a building and clears it on null", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement);
    const el = hud.el as unknown as FakeElement;
    const prompt = el.querySelector("[data-prompt]")!;

    hud.setPrompt("garage");
    expect(prompt.style.opacity).toBe("1");
    expect(el.querySelector("[data-pname]")!.textContent).toContain("GARAGE");
    expect(el.querySelector("[data-pdesc]")!.textContent.length).toBeGreaterThan(0);

    hud.setPrompt(null);
    expect(prompt.style.opacity).toBe("0");
  });

  test("setProgress drives the card's auto-open fill", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement);
    const fill = (hud.el as unknown as FakeElement).querySelector("[data-pfill]")!;

    hud.setPrompt("track");
    hud.setProgress(0.5);
    expect(fill.style.width).toBe("50%");
    hud.setProgress(2); // clamped
    expect(fill.style.width).toBe("100%");

    hud.setPrompt(null); // leaving the ring resets the fill
    expect(fill.style.width).toBe("0%");
  });

  test("marks the highway entry as coming soon", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement);
    const el = hud.el as unknown as FakeElement;

    hud.setPrompt("highway");
    expect(el.querySelector("[data-pname]")!.textContent).toContain("HIGHWAY");
    expect(el.querySelector("[data-pdesc]")!.textContent).toContain("coming soon");
  });

  test("toast shows a transient message", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const hud = createLobbyHud(parent as unknown as HTMLElement);
    const toast = (hud.el as unknown as FakeElement).querySelector("[data-toast]")!;

    hud.toast("Crate Shop — coming soon");
    expect(toast.style.opacity).toBe("1");
    expect(toast.textContent).toContain("Crate Shop");
  });
});
