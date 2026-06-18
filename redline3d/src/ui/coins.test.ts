import { afterEach, describe, expect, test, vi } from "vitest";
import { createCoinCounter } from "./coins";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  style = { cssText: "" };
  textContent = "";
  private html = "";

  classList = {
    add: vi.fn(),
    remove: vi.fn(),
  };

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    if (value.includes('id="coinTotal"')) {
      const total = new FakeElement();
      total.id = "coinTotal";
      total.className = "num coin-total";
      this.children.push(total);
    }
  }

  get offsetWidth() {
    return 0;
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  querySelector(selector: string) {
    if (selector !== "#coinTotal") return null;
    return this.children.find((child) => child.id === "coinTotal") ?? null;
  }

  setAttribute() {}
}

function installFakeDocument() {
  const head = new FakeElement();
  vi.stubGlobal("document", {
    createElement: () => new FakeElement(),
    head,
  });
}

describe("createCoinCounter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("centers the coin value inside the counter block", () => {
    installFakeDocument();
    const parent = new FakeElement();

    createCoinCounter(parent as unknown as HTMLElement);

    expect(parent.children[0].style.cssText).toContain("align-items:center");
    expect(parent.children[0].style.cssText).toContain("text-align:center");
  });
});
