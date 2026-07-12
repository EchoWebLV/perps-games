import { afterEach, describe, expect, test, vi } from "vitest";
import { createScrapCounter } from "./scrap";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  style: { cssText: string; top?: string } = { cssText: "" };
  textContent = "";
  private html = "";

  classList = { add: vi.fn(), remove: vi.fn() };

  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    if (value.includes('id="scrapTotal"')) {
      const total = new FakeElement();
      total.id = "scrapTotal";
      this.children.push(total);
    }
  }

  get offsetWidth() { return 0; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  querySelector(selector: string) {
    if (selector !== "#scrapTotal") return null;
    return this.children.find((child) => child.id === "scrapTotal") ?? null;
  }
  setAttribute() {}
}

function installFakeDocument() {
  vi.stubGlobal("document", {
    createElement: () => new FakeElement(),
    head: new FakeElement(),
  });
}

describe("createScrapCounter", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("moves directly below coins in the lobby balance stack", () => {
    installFakeDocument();
    const parent = new FakeElement();

    const counter = createScrapCounter(parent as unknown as HTMLElement);
    counter.setLobbyPosition(true);

    expect(parent.children[0].style.top).toContain("98px");
    counter.setLobbyPosition(false);
    expect(parent.children[0].style.top).toContain("184px");
  });
});
