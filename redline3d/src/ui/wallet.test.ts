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

const makeOnchain = (status = { delegated: false, playCents: 0 }) => ({
  status: () => status,
  end: vi.fn(async () => {}),
  withdraw: vi.fn(async () => {}),
});
const ADDR = "Wallet1111111111111111111111111111111111";

describe("createWallet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the deposit QR + address + copy for the session wallet (SOL framing)", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => ADDR,
      balance: () => 0,
      onchain: makeOnchain(),
    });

    wallet.open();

    const overlay = parent.children[0];
    const recv = overlay.querySelector<FakeElement>("#wltRecv");
    expect(recv?.innerHTML).toContain("Send SOL to this address");
    expect(recv?.innerHTML).toContain("Solana devnet");
    expect(recv?.querySelector("#wltCopy")).toBeTruthy();
  });

  it("shows a setup hint (no QR) when the wallet address is not ready yet", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "",
      balance: () => 0,
      onchain: makeOnchain(),
    });

    wallet.open();

    const overlay = parent.children[0];
    const recv = overlay.querySelector<FakeElement>("#wltRecv");
    expect(recv?.innerHTML).toContain("Setting up your wallet");
    expect(recv?.querySelector("#wltCopy")).toBeNull();
  });

  it("copies the deposit address", async () => {
    const parent = new FakeElement("div");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => ADDR,
      balance: () => 0,
      onchain: makeOnchain(),
    });

    wallet.open();

    const overlay = parent.children[0];
    const copyBtn = overlay.querySelector<FakeElement>("#wltCopy");
    expect(copyBtn).toBeTruthy();

    await copyBtn?.onclick?.();

    expect(writeText).toHaveBeenCalledWith(ADDR);
    expect(copyBtn?.innerHTML).toContain("Copied");
  });

  it("shows the play balance in SOL in the hero at 3 decimals (centi-SOL units → SOL)", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => ADDR,
      balance: () => 25, // 25 centi-SOL units = 0.25 SOL
      onchain: makeOnchain(),
    });

    wallet.open();

    const overlay = parent.children[0];
    // 3 decimals so small SOL balances (a cash-out leaves sub-0.01 SOL) stay visible.
    expect(overlay.querySelector<FakeElement>("#wltBal")?.textContent).toBe("0.250");
  });

  it("enables End while a session is live and disables Withdraw", async () => {
    const parent = new FakeElement("div");
    const onchain = { status: () => ({ delegated: true, playCents: 10 }), end: vi.fn(async () => {}), withdraw: vi.fn(async () => {}) };
    const wallet = createWallet(parent as unknown as HTMLElement, { address: () => ADDR, balance: () => 10, onchain });

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltOcEnd")?.attrs.disabled).toBeUndefined(); // delegated → End enabled
    expect(overlay.querySelector<FakeElement>("#wltOcWd")?.attrs.disabled).toBe("");          // delegated → Withdraw disabled

    await overlay.querySelector<FakeElement>("#wltOcEnd")?.onclick?.(undefined);
    expect(onchain.end).toHaveBeenCalledTimes(1);
  });

  it("enables Withdraw only when idle with a non-zero balance", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => ADDR,
      balance: () => 10,
      onchain: makeOnchain({ delegated: false, playCents: 10 }),
    });

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltOcEnd")?.attrs.disabled).toBe("");          // idle → End disabled
    expect(overlay.querySelector<FakeElement>("#wltOcWd")?.attrs.disabled).toBeUndefined();     // idle + balance → Withdraw enabled
  });

  it("drops the legacy connect-wallet / USDC / add-to-play UI", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => ADDR,
      balance: () => 0,
      onchain: makeOnchain(),
    });

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector(".wlt-connect")).toBeNull();
    expect(overlay.querySelector("#wltAddPlay")).toBeNull();
    expect(overlay.querySelector(".wlt-seg")).toBeNull();
    expect(overlay.querySelector<FakeElement>("#wltRecv")?.innerHTML).not.toContain("USDC");
  });
});
