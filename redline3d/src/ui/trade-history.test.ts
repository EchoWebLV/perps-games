// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeHistoryItem, TradeHistoryPage } from "../core/api";
import { createTradeHistory } from "./trade-history";

const firstTrade: TradeHistoryItem = {
  id: "11111111-1111-4111-8111-111111111111",
  walletPublicKey: "AliceWallet",
  asset: "SOL",
  dir: 1,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150,
  exitPrice: 151.25,
  openedAt: "2026-07-10T10:00:00.000Z",
  outcome: "cashout",
  payoutBase: 11_000_000,
  pnlBase: 1_000_000,
  settledAt: "2026-07-10T10:01:00.000Z",
};

const secondTrade: TradeHistoryItem = {
  ...firstTrade,
  id: "22222222-2222-4222-8222-222222222222",
  asset: "BTC",
  dir: -1,
  lev: 100,
  stakeBase: 20_000_000,
  entryPrice: 105_000,
  exitPrice: 105_250,
  outcome: "liq",
  payoutBase: 0,
  pnlBase: -20_000_000,
  settledAt: "2026-07-10T09:01:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function mount(options: {
  signedIn?: boolean;
  flush?: () => Promise<void>;
  load?: (cursor?: string) => Promise<TradeHistoryPage>;
} = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const flush = vi.fn(options.flush ?? (async () => undefined));
  const load = vi.fn(options.load ?? (async () => ({ items: [], nextCursor: null })));
  const panel = createTradeHistory(host, {
    signedIn: () => options.signedIn ?? true,
    flush,
    load,
  });
  return { host, panel, flush, load };
}

const historyBody = () => document.querySelector<HTMLElement>(".trade-history-body");
const tradeRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-trade-id]"));

beforeEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll(".trade-history-styles").forEach((style) => style.remove());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trade history states", () => {
  it("shows sign-in-required without flushing or loading guest history", async () => {
    const { panel, flush, load } = mount({ signedIn: false });

    await panel.open();

    expect(document.body.textContent).toContain("Sign in to view your trade history");
    expect(flush).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("announces loading while the initial request is pending", async () => {
    const page = deferred<TradeHistoryPage>();
    const { panel } = mount({ load: () => page.promise });

    const opening = panel.open();
    await Promise.resolve();

    expect(historyBody()?.textContent).toContain("Loading history");
    page.resolve({ items: [], nextCursor: null });
    await opening;
  });

  it("shows an empty state when the account has no settled trades", async () => {
    const { panel } = mount();

    await panel.open();

    expect(historyBody()?.textContent).toContain("No settled trades yet");
  });

  it("renders newest-first response order and every settled-trade value", async () => {
    const { panel } = mount({
      load: async () => ({ items: [firstTrade, secondTrade], nextCursor: null }),
    });

    await panel.open();

    const rows = tradeRows();
    expect(rows.map((row) => row.dataset.tradeId)).toEqual([firstTrade.id, secondTrade.id]);
    expect(rows[0]?.textContent).toContain(new Date(firstTrade.settledAt).toLocaleString());
    expect(rows[0]?.textContent).toContain("SOL");
    expect(rows[0]?.textContent).toContain("LONG");
    expect(rows[0]?.textContent).toContain("Leverage 250×");
    expect(rows[0]?.textContent).toContain("Stake 0.010 SOL");
    expect(rows[0]?.textContent).toContain("150 → 151.25");
    expect(rows[0]?.textContent).toContain("CASHOUT");
    expect(rows[0]?.textContent).toContain("Payout 0.011 SOL");
    expect(rows[0]?.textContent).toContain("P&L +0.001 SOL");
    expect(rows[1]?.textContent).toContain("SHORT");
    expect(rows[1]?.textContent).toContain("P&L -0.020 SOL");
  });

  it("shows a retry action after a failure and recovers on retry", async () => {
    let attempts = 0;
    const { panel, load } = mount({
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return { items: [], nextCursor: null };
      },
    });
    await panel.open();

    expect(historyBody()?.textContent).toContain("Could not load history");
    document.querySelector<HTMLButtonElement>('[data-history="retry"]')?.click();
    await vi.waitFor(() => {
      expect(historyBody()?.textContent).toContain("No settled trades yet");
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("trade history pagination", () => {
  it("loads the next cursor and appends its trades", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));

    expect(load).toHaveBeenLastCalledWith("next");
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([firstTrade.id, secondTrade.id]);
  });

  it("deduplicates repeated trade ids and stops a repeated cursor loop", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [firstTrade, secondTrade], nextCursor: "next" });
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));

    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([firstTrade.id, secondTrade.id]);
    expect(document.querySelector('[data-history="more"]')).toBeNull();
  });

  it("does not start a duplicate page request from repeated clicks", async () => {
    const nextPage = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockImplementationOnce(() => nextPage.promise);
    const { panel } = mount({ load });
    await panel.open();

    const more = document.querySelector<HTMLButtonElement>('[data-history="more"]');
    more?.click();
    more?.click();

    expect(load).toHaveBeenCalledTimes(2);
    nextPage.resolve({ items: [secondTrade], nextCursor: null });
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));
  });
});

describe("trade history modal behavior", () => {
  it("uses modal semantics and native controls, then focuses the close button", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { panel } = mount({ signedIn: false });

    await panel.open();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const title = document.querySelector<HTMLElement>(".trade-history-title");
    const buttons = Array.from(document.querySelectorAll(".trade-history-panel button"));
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button instanceof HTMLButtonElement)).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-history="close"]'));
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { panel } = mount({ signedIn: false });
    await panel.open();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(panel.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes from a backdrop click", async () => {
    const { panel } = mount({ signedIn: false });
    await panel.open();

    document.querySelector<HTMLElement>(".trade-history-overlay")?.click();

    expect(panel.isOpen()).toBe(false);
  });

  it("ignores an earlier response after close and reopen", async () => {
    const stalePage = deferred<TradeHistoryPage>();
    const currentPage = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockImplementationOnce(() => stalePage.promise)
      .mockImplementationOnce(() => currentPage.promise);
    const { panel } = mount({ load });

    const firstOpening = panel.open();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    panel.close();
    const secondOpening = panel.open();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    currentPage.resolve({ items: [secondTrade], nextCursor: null });
    await secondOpening;
    stalePage.resolve({ items: [firstTrade], nextCursor: null });
    await firstOpening;

    expect(panel.isOpen()).toBe(true);
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([secondTrade.id]);
  });
});

describe("trade history rendering safety", () => {
  it("renders server strings as text instead of markup", async () => {
    const hostileTrade = {
      ...firstTrade,
      asset: '<img src=x data-hostile="asset">',
      outcome: '<script data-hostile="outcome">boom()</script>',
    } as unknown as TradeHistoryItem;
    const { panel } = mount({
      load: async () => ({ items: [hostileTrade], nextCursor: null }),
    });

    await panel.open();

    expect(tradeRows()[0]?.textContent).toContain('<img src=x data-hostile="asset">');
    expect(document.querySelector("[data-hostile]")).toBeNull();
  });

  it("injects only trade-history-scoped CSS selectors", () => {
    mount();

    const css = document.querySelector<HTMLStyleElement>(".trade-history-styles")?.textContent ?? "";
    expect(css).toContain(".trade-history-overlay");
    expect(css).not.toMatch(/(?:^|})\s*(?:button|header|h2|article|p)(?:\W|$)/m);
  });
});
