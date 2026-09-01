// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeHistoryItem, TradeHistoryPage } from "../core/api";
import { createTradeHistory } from "./trade-history";
import { SOL_STAKE_CURRENCY } from "../core/stake-currency";

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
    // the parked solana rail's framing — these rows assert SOL formatting explicitly
    currency: SOL_STAKE_CURRENCY,
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
    expect(rows[0]?.querySelector("time")?.dateTime).toBe(firstTrade.settledAt);
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
    const retry = document.querySelector<HTMLButtonElement>('[data-history="retry"]');
    retry?.focus();
    retry?.click();
    await vi.waitFor(() => {
      expect(historyBody()?.textContent).toContain("No settled trades yet");
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(document.querySelector('[data-history="close"]'));
  });

  it("keeps focus inside while a retried request is pending", async () => {
    const retryPage = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => retryPage.promise);
    const { panel } = mount({ load });
    await panel.open();

    const retry = document.querySelector<HTMLButtonElement>('[data-history="retry"]');
    const close = document.querySelector<HTMLButtonElement>('[data-history="close"]');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    retry?.focus();
    retry?.click();

    expect(load).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(close);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    retryPage.resolve({ items: [], nextCursor: null });
    await vi.waitFor(() => expect(historyBody()?.textContent).toContain("No settled trades yet"));
  });
});

describe("trade history pagination", () => {
  it("loads the next cursor and appends its trades", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ load });
    await panel.open();

    const more = document.querySelector<HTMLButtonElement>('[data-history="more"]');
    more?.focus();
    more?.click();
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));

    expect(load).toHaveBeenLastCalledWith("next");
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([firstTrade.id, secondTrade.id]);
    expect(document.activeElement).toBe(tradeRows()[1]);
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

  it("keeps focus inside while an appended page is pending", async () => {
    const nextPage = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockImplementationOnce(() => nextPage.promise);
    const { panel } = mount({ load });
    await panel.open();

    const more = document.querySelector<HTMLButtonElement>('[data-history="more"]');
    const close = document.querySelector<HTMLButtonElement>('[data-history="close"]');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    more?.focus();
    more?.click();

    expect(load).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(close);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    nextPage.resolve({ items: [secondTrade], nextCursor: null });
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));
  });

  it("keeps prior rows and retries an append with the original cursor", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(document.querySelector('[data-history="retry"]')).not.toBeNull());
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([firstTrade.id]);
    expect(load).toHaveBeenLastCalledWith("next");

    const retry = document.querySelector<HTMLButtonElement>('[data-history="retry"]');
    retry?.focus();
    retry?.click();
    await vi.waitFor(() => expect(tradeRows()).toHaveLength(2));

    expect(load.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "next", "next"]);
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([firstTrade.id, secondTrade.id]);
    expect(document.activeElement).toBe(tradeRows()[1]);
  });

  it("does not render an append response after close", async () => {
    const appendPage = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockImplementationOnce(() => appendPage.promise);
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    panel.close();
    appendPage.resolve({ items: [secondTrade], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.isOpen()).toBe(false);
    expect(tradeRows()).toHaveLength(0);
  });

  it("ignores a rejected stale append after close and reopen", async () => {
    const staleAppend = deferred<TradeHistoryPage>();
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockImplementationOnce(() => staleAppend.promise)
      .mockResolvedValueOnce({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    panel.close();
    await panel.open();
    staleAppend.reject(new Error("stale offline response"));
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.isOpen()).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
    expect(tradeRows().map((row) => row.dataset.tradeId)).toEqual([secondTrade.id]);
    expect(historyBody()?.textContent).not.toContain("Could not load history");
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

  it("wraps Tab and Shift+Tab inside the open modal", async () => {
    const before = document.createElement("button");
    before.textContent = "Before history";
    document.body.appendChild(before);
    const { panel } = mount({
      load: async () => ({ items: [firstTrade], nextCursor: "next" }),
    });
    const after = document.createElement("button");
    after.textContent = "After history";
    document.body.appendChild(after);
    await panel.open();

    const close = document.querySelector<HTMLButtonElement>('[data-history="close"]');
    const more = document.querySelector<HTMLButtonElement>('[data-history="more"]');
    close?.focus();
    const backwards = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(more);

    const forwards = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(forwards);
    expect(forwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    after.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(before);
    expect(document.activeElement).not.toBe(after);
  });

  it("contains both Tab directions from a programmatically focused terminal row", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [firstTrade], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ load });
    await panel.open();

    document.querySelector<HTMLButtonElement>('[data-history="more"]')?.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(tradeRows()[1]));
    const terminalRow = tradeRows()[1];
    const close = document.querySelector<HTMLButtonElement>('[data-history="close"]');

    const forwards = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(forwards);
    expect(forwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(outside);

    terminalRow.focus();
    const backwards = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(outside);
  });

  it("focuses the dialog when no enabled modal control remains", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { panel } = mount({ signedIn: false });
    await panel.open();
    const close = document.querySelector<HTMLButtonElement>('[data-history="close"]');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (close) close.disabled = true;
    outside.focus();

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
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

  it.each([
    ["hidden", (opener: HTMLButtonElement) => { opener.hidden = true; }],
    ["disabled", (opener: HTMLButtonElement) => { opener.disabled = true; }],
  ])("does not restore focus to a %s opener", async (_state, makeUnavailable) => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { panel } = mount({ signedIn: false });
    await panel.open();
    makeUnavailable(opener);

    panel.close();

    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(opener);
  });

  it("does not leave focus in the hidden dialog when no control opened it", async () => {
    expect(document.activeElement).toBe(document.body);
    const { panel } = mount({ signedIn: false });
    await panel.open();

    panel.close();

    expect(document.activeElement).toBe(document.body);
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

  it("does not load after closing during the pre-load flush", async () => {
    const pendingFlush = deferred<void>();
    const { panel, load } = mount({ flush: () => pendingFlush.promise });

    const opening = panel.open();
    expect(historyBody()?.textContent).toContain("Loading history");
    panel.close();
    pendingFlush.resolve(undefined);
    await opening;

    expect(panel.isOpen()).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(tradeRows()).toHaveLength(0);
  });

  it("ignores an older pre-load flush after reopening", async () => {
    const staleFlush = deferred<void>();
    const currentFlush = deferred<void>();
    const flush = vi.fn()
      .mockImplementationOnce(() => staleFlush.promise)
      .mockImplementationOnce(() => currentFlush.promise);
    const load = vi.fn().mockResolvedValue({ items: [secondTrade], nextCursor: null });
    const { panel } = mount({ flush, load });

    const staleOpening = panel.open();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    panel.close();
    const currentOpening = panel.open();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    currentFlush.resolve(undefined);
    await currentOpening;
    staleFlush.resolve(undefined);
    await staleOpening;

    expect(load).toHaveBeenCalledTimes(1);
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

    const style = document.querySelector<HTMLStyleElement>(".trade-history-styles");
    const selectors = (rules: CSSRuleList): string[] => Array.from(rules).flatMap((rule) => {
      if ("selectorText" in rule) {
        return (rule as CSSStyleRule).selectorText.split(",").map((selector) => selector.trim());
      }
      if ("cssRules" in rule) return selectors((rule as CSSMediaRule).cssRules);
      return [];
    });
    const allSelectors = selectors(style?.sheet?.cssRules ?? [] as unknown as CSSRuleList);

    expect(allSelectors.length).toBeGreaterThan(0);
    expect(allSelectors.filter((selector) => !selector.startsWith(".trade-history-"))).toEqual([]);
  });
});
