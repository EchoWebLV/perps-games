import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWallet } from "./wallet";

class FakeClassList {
  private classes = new Set<string>();

  constructor(initial = "") {
    for (const name of initial.split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  add(...names: string[]) {
    for (const name of names) this.classes.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.classes.delete(name);
  }

  contains(name: string) {
    return this.classes.has(name);
  }

  toggle(name: string, force?: boolean) {
    const next = force ?? !this.classes.has(name);
    if (next) this.classes.add(name);
    else this.classes.delete(name);
    return next;
  }

  toString() {
    return [...this.classes].join(" ");
  }
}

class FakeElement {
  tagName: string;
  id = "";
  disabled = false;
  hidden = false;
  onclick: ((event?: unknown) => void | Promise<void>) | null = null;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = { cssText: "", display: "" };
  classList = new FakeClassList();
  private html = "";
  private text = "";

  constructor(tagName = "div") {
    this.tagName = tagName.toLowerCase();
  }

  set className(value: string) {
    this.classList = new FakeClassList(value);
  }

  get className() {
    return this.classList.toString();
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    for (const child of parseHtml(value)) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this.html;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get textContent() {
    return this.text;
  }

  get offsetWidth() {
    return 0;
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
  }

  querySelector<T extends FakeElement>(selector: string): T | null {
    return (this.querySelectorAll(selector)[0] as T | undefined) ?? null;
  }

  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out as T[];
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function parseHtml(html: string): FakeElement[] {
  const out: FakeElement[] = [];
  const tagRe = /<([a-z0-9]+)([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const [, tagName, rawAttrs] = match;
    const el = new FakeElement(tagName);
    const attrRe = /([:@a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(rawAttrs))) {
      const [, name, value = ""] = attr;
      el.setAttribute(name, value);
    }
    out.push(el);
  }
  return out;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  const exactAttr = selector.match(/^\[data-([a-z0-9_-]+)\]$/i);
  if (exactAttr) return element.dataset[exactAttr[1]] !== undefined;

  const classAttr = selector.match(/^\.([a-z0-9_-]+)\[data-([a-z0-9_-]+)="([^"]+)"\]$/i);
  if (classAttr) {
    const [, klass, dataKey, value] = classAttr;
    return element.classList.contains(klass) && element.dataset[dataKey] === value;
  }

  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.tagName === selector.toLowerCase();
}

function installFakeDom() {
  const head = new FakeElement("head");
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeElement(tag),
    head,
  });
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn(async () => {}),
    },
  });
  vi.stubGlobal("addEventListener", vi.fn());
}

const ADDR = "0x1111111111111111111111111111111111111111";

function makeOpts(over: Partial<Parameters<typeof createWallet>[1]> = {}) {
  return {
    address: () => ADDR,
    balance: () => 0,
    deposit: { minCents: 100, maxCents: 500, send: vi.fn(async () => "0xhash") },
    withdraw: { minCents: 100, maxCents: 500, request: vi.fn(async () => {}) },
    ...over,
  } as Parameters<typeof createWallet>[1];
}

describe("createWallet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the server cash balance in dollars", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts({ balance: () => 250 }));

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltBal")?.textContent).toBe("2.50");
  });

  it("shows the wallet's own USDC under the hero so a deposit visibly arrives", async () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(
      parent as unknown as HTMLElement,
      makeOpts({ fetchWalletUsdc: vi.fn(async () => 3_250_000n) }),
    );

    wallet.open();
    await Promise.resolve(); await Promise.resolve();

    const overlay = parent.children[0];
    const sub = overlay.querySelector<FakeElement>(".wlt-hero-sub")?.textContent ?? "";
    expect(sub).toContain("Robinhood Chain");
    expect(sub).toContain("wallet 3.25 USDC");
  });

  it("keeps the plain network line when the wallet USDC read is unavailable", async () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(
      parent as unknown as HTMLElement,
      makeOpts({ fetchWalletUsdc: vi.fn(async () => null) }),
    );

    wallet.open();
    await Promise.resolve(); await Promise.resolve();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>(".wlt-hero-sub")?.textContent).toBe("Robinhood Chain");
  });

  it("deposits the stepper amount in CENTS through deposit.send", async () => {
    const parent = new FakeElement("div");
    const opts = makeOpts();
    const wallet = createWallet(parent as unknown as HTMLElement, opts);

    wallet.open();

    const overlay = parent.children[0];
    await overlay.querySelector<FakeElement>("#wltDepUp")?.onclick?.();       // 100 → 200
    await overlay.querySelector<FakeElement>("#wltDepGo")?.onclick?.();

    expect(opts.deposit.send).toHaveBeenCalledWith(200);
    expect(overlay.querySelector<FakeElement>("#wltDepVal")?.textContent).toBe("$2.00");
    expect(overlay.querySelector<FakeElement>("#wltDepStatus")?.textContent).toContain("Deposit sent");
  });

  it("clamps the deposit stepper to the configured min/max", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts());

    wallet.open();

    const overlay = parent.children[0];
    const dn = overlay.querySelector<FakeElement>("#wltDepDn");
    const up = overlay.querySelector<FakeElement>("#wltDepUp");
    dn?.onclick?.(); dn?.onclick?.();                                          // floor at min
    expect(overlay.querySelector<FakeElement>("#wltDepVal")?.textContent).toBe("$1.00");
    for (let i = 0; i < 9; i++) up?.onclick?.();                               // ceiling at max
    expect(overlay.querySelector<FakeElement>("#wltDepVal")?.textContent).toBe("$5.00");
  });

  it("requests a withdrawal for the stepper amount and never posts an address", async () => {
    const parent = new FakeElement("div");
    const opts = makeOpts({ balance: () => 500 });
    const wallet = createWallet(parent as unknown as HTMLElement, opts);

    wallet.open();

    const overlay = parent.children[0];
    await overlay.querySelector<FakeElement>("#wltWdUp")?.onclick?.();        // 100 → 200
    await overlay.querySelector<FakeElement>("#wltWdGo")?.onclick?.();

    expect(opts.withdraw.request).toHaveBeenCalledWith(200);
    expect(overlay.querySelector<FakeElement>("#wltWdStatus")?.textContent)
      .toBe("Withdrawal requested — arrives after review.");
  });

  it("clamps the withdraw stepper to the configured min/max", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(
      parent as unknown as HTMLElement,
      makeOpts({ balance: () => 100_000, withdraw: { minCents: 100, maxCents: 300, request: vi.fn(async () => {}) } }),
    );

    wallet.open();

    const overlay = parent.children[0];
    const up = overlay.querySelector<FakeElement>("#wltWdUp");
    for (let i = 0; i < 9; i++) up?.onclick?.();
    expect(overlay.querySelector<FakeElement>("#wltWdVal")?.textContent).toBe("$3.00");
  });

  it("disables cash out below the withdrawal minimum", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts({ balance: () => 99 }));

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltWdGo")?.attrs.disabled).toBe("");
  });

  it("renders the player's own funding address as QR + copy, labelled for Robinhood Chain", async () => {
    const parent = new FakeElement("div");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts());

    wallet.open();

    const overlay = parent.children[0];
    const recv = overlay.querySelector<FakeElement>("#wltRecv");
    expect(recv?.innerHTML).toContain("Fund this wallet with USDC on Robinhood Chain");
    expect(recv?.innerHTML).toContain("plus a little ETH for gas");

    const copyBtn = overlay.querySelector<FakeElement>("#wltCopy");
    await copyBtn?.onclick?.();
    expect(writeText).toHaveBeenCalledWith(ADDR);
    expect(copyBtn?.innerHTML).toContain("Copied");
  });

  it("shows a setup hint (no QR) when the wallet address is not ready yet", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts({ address: () => "" }));

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltRecv")?.innerHTML).toContain("Setting up your wallet");
    expect(overlay.querySelector("#wltCopy")).toBeNull();
  });

  it("drops every trace of the ER session lifecycle from the cashier", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, makeOpts());

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector("#wltOcEnd")).toBeNull();
    expect(overlay.querySelector("#wltOcCash")).toBeNull();
    expect(overlay.querySelector(".wlt-connect")).toBeNull();
    expect(overlay.querySelector("#wltAddPlay")).toBeNull();
  });
});
