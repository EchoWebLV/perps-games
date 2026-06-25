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

describe("createWallet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders connect wallet buttons when no wallet is connected and connects from the button path", async () => {
    const parent = new FakeElement("div");
    let address = "";
    const onConnectWallet = vi.fn(async () => {
      address = "Wallet1111111111111111111111111111111111";
    });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => address,
      balance: () => 0,
      onConnectWallet,
    });

    wallet.open();

    const overlay = parent.children[0];
    const connectButtons = overlay.querySelectorAll<FakeElement>(".wlt-connect");
    expect(connectButtons).toHaveLength(2);

    await connectButtons[0].onclick?.(undefined);

    expect(onConnectWallet).toHaveBeenCalledTimes(1);
    const recv = overlay.querySelector<FakeElement>('.wlt-view[data-view="recv"]');
    expect(recv?.innerHTML).toContain("This QR is your connected wallet.");
    expect(recv?.querySelector("#wltCopy")).toBeTruthy();
  });

  it("shows a no-wallet message when connect has no Solana provider", async () => {
    const parent = new FakeElement("div");
    const onConnectWallet = vi.fn(async () => {
      throw new Error("no_solana_wallet_installed");
    });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "",
      balance: () => 0,
      onConnectWallet,
    });

    wallet.open();

    const overlay = parent.children[0];
    const connectButtons = overlay.querySelectorAll<FakeElement>(".wlt-connect");

    await connectButtons[0].onclick?.(undefined);

    expect(connectButtons[0].textContent).toBe("No wallet found");
    expect(connectButtons[0].disabled).toBe(true);

    vi.runAllTimers();
    expect(connectButtons[0].textContent).toBe("Connect wallet");
    expect(connectButtons[0].disabled).toBe(false);
  });

  it("shows a loading message when wallet adapter preload is not ready yet", async () => {
    const parent = new FakeElement("div");
    const onConnectWallet = vi.fn(async () => {
      throw new Error("wallet_port_loading");
    });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "",
      balance: () => 0,
      onConnectWallet,
    });

    wallet.open();

    const overlay = parent.children[0];
    const connectButtons = overlay.querySelectorAll<FakeElement>(".wlt-connect");

    await connectButtons[0].onclick?.(undefined);

    expect(connectButtons[0].textContent).toBe("Wallet loading");
  });

  it("uses API body errors when mapping wallet connect failures", async () => {
    const parent = new FakeElement("div");
    const onConnectWallet = vi.fn(async () => {
      throw { name: "ApiError", message: "round_already_open", bodyError: "wallet_already_bound" };
    });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "",
      balance: () => 0,
      onConnectWallet,
    });

    wallet.open();

    const overlay = parent.children[0];
    const connectButtons = overlay.querySelectorAll<FakeElement>(".wlt-connect");

    await connectButtons[0].onclick?.(undefined);

    expect(connectButtons[0].textContent).toBe("Wallet already linked");
  });

  it("copies the connected wallet address from Receive", async () => {
    const parent = new FakeElement("div");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "Wallet1111111111111111111111111111111111",
      balance: () => 0,
    });

    wallet.open();

    const overlay = parent.children[0];
    const copyBtn = overlay.querySelector<FakeElement>("#wltCopy");
    expect(copyBtn).toBeTruthy();

    await copyBtn?.onclick?.();

    expect(writeText).toHaveBeenCalledWith("Wallet1111111111111111111111111111111111");
    expect(copyBtn?.innerHTML).toContain("Copied");
  });

  it("shows the connected wallet balance in the hero and play balance separately", () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "Wallet1111111111111111111111111111111111",
      balance: () => 17500,
      walletBalance: () => 10000,
    });

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>("#wltBal")?.textContent).toBe("100.00");
    expect(overlay.querySelector<FakeElement>("#wltPlayBal")?.textContent).toBe("75.00");
  });

  it("does not render fake buy amounts and routes funding to Receive", async () => {
    const parent = new FakeElement("div");
    const wallet = createWallet(parent as unknown as HTMLElement, {
      address: () => "Wallet1111111111111111111111111111111111",
      balance: () => 0,
    });

    wallet.open();

    const overlay = parent.children[0];
    expect(overlay.querySelector<FakeElement>(".wlt-amts")).toBeNull();
    expect(overlay.querySelector<FakeElement>("#wltBuy")).toBeNull();

    const receiveCta = overlay.querySelector<FakeElement>(".wlt-receive-cta");
    const recv = overlay.querySelector<FakeElement>('.wlt-view[data-view="recv"]');
    expect(receiveCta).toBeTruthy();
    expect(recv?.hidden).toBe(true);

    await receiveCta?.onclick?.(undefined);

    expect(recv?.hidden).toBe(false);
  });
});
