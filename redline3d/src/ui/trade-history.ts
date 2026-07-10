import type { TradeHistoryItem, TradeHistoryPage } from "../core/api";

export interface TradeHistoryPanel {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

interface TradeHistoryDependencies {
  signedIn(): boolean;
  flush(): Promise<void>;
  load(cursor?: string): Promise<TradeHistoryPage>;
}

let titleSequence = 0;

function addStyles(doc: Document): void {
  if (doc.querySelector("style.trade-history-styles")) return;

  const style = doc.createElement("style");
  style.className = "trade-history-styles";
  style.textContent = `
    .trade-history-overlay {
      position: fixed;
      inset: 0;
      z-index: 42;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: max(18px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom));
      background: rgba(5, 3, 16, .78);
      backdrop-filter: blur(5px);
      pointer-events: auto;
    }
    .trade-history-overlay[hidden] { display: none; }
    .trade-history-panel {
      width: min(680px, 96vw);
      max-height: min(760px, 88vh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(39, 231, 255, .42);
      border-radius: 18px;
      background: rgba(12, 10, 26, .96);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .68), 0 0 28px rgba(39, 231, 255, .12);
      color: var(--ink, #eef1ff);
    }
    .trade-history-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid rgba(132, 150, 224, .22);
    }
    .trade-history-title {
      flex: 1;
      margin: 0;
      font: 800 17px/1 'Chakra Petch', ui-monospace, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .trade-history-button {
      min-height: 40px;
      padding: 10px 14px;
      border: 1px solid rgba(39, 231, 255, .38);
      border-radius: 10px;
      background: rgba(30, 24, 62, .82);
      color: var(--ink, #eef1ff);
      font: 700 11px/1 'Chakra Petch', ui-monospace, monospace;
      cursor: pointer;
    }
    .trade-history-button:disabled { cursor: wait; opacity: .72; }
    .trade-history-button:focus-visible { outline: 2px solid var(--cyan, #27e7ff); outline-offset: 2px; }
    .trade-history-close { width: 40px; padding: 0; font-size: 17px; }
    .trade-history-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 150px;
      overflow: auto;
      padding: 14px 18px max(18px, env(safe-area-inset-bottom));
    }
    .trade-history-status {
      margin: auto;
      text-align: center;
      color: var(--mut, #aeb8dc);
      font: 600 12px/1.5 'Chakra Petch', ui-monospace, monospace;
    }
    .trade-history-error { color: #ff9db1; }
    .trade-history-row {
      display: grid;
      gap: 8px;
      padding: 13px 14px;
      border: 1px solid rgba(132, 150, 224, .22);
      border-radius: 12px;
      background: rgba(18, 14, 40, .72);
    }
    .trade-history-date {
      color: var(--mut, #aeb8dc);
      font: 600 10px/1.25 'Chakra Petch', ui-monospace, monospace;
      letter-spacing: .03em;
    }
    .trade-history-main {
      color: var(--cyan, #27e7ff);
      font: 800 12px/1.25 'Chakra Petch', ui-monospace, monospace;
      letter-spacing: .04em;
    }
    .trade-history-values {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      color: rgba(226, 230, 255, .82);
      font: 600 11px/1.45 'Chakra Petch', ui-monospace, monospace;
    }
    .trade-history-pnl { font-weight: 800; }
    .trade-history-pnl--positive { color: #64f5ad; }
    .trade-history-pnl--negative { color: #ff809b; }
    .trade-history-pnl--flat { color: var(--mut, #aeb8dc); }
    .trade-history-more { align-self: center; min-width: 128px; margin-top: 2px; }
    .trade-history-retry { align-self: center; min-width: 100px; }
    @media (max-width: 520px) {
      .trade-history-overlay { align-items: flex-end; padding: max(12px, env(safe-area-inset-top)) 0 0; }
      .trade-history-panel { width: 100%; max-height: 82vh; border-radius: 20px 20px 0 0; }
      .trade-history-values { font-size: 10px; }
    }
  `;
  doc.head.appendChild(style);
}

function uniqueTrades(existing: TradeHistoryItem[], incoming: TradeHistoryItem[]): TradeHistoryItem[] {
  const ids = new Set(existing.map((trade) => trade.id));
  const merged = [...existing];
  for (const trade of incoming) {
    if (ids.has(trade.id)) continue;
    ids.add(trade.id);
    merged.push(trade);
  }
  return merged;
}

export function createTradeHistory(
  parent: HTMLElement,
  deps: TradeHistoryDependencies,
): TradeHistoryPanel {
  const doc = parent.ownerDocument;
  addStyles(doc);

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const overlay = make("div", "trade-history-overlay");
  overlay.hidden = true;

  const dialog = make("section", "trade-history-panel");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.tabIndex = -1;

  const header = make("header", "trade-history-header");
  const title = make("h2", "trade-history-title", "History");
  title.id = `trade-history-title-${++titleSequence}`;
  dialog.setAttribute("aria-labelledby", title.id);

  const closeButton = make("button", "trade-history-button trade-history-close", "×");
  closeButton.type = "button";
  closeButton.dataset.history = "close";
  closeButton.setAttribute("aria-label", "Close history");
  header.append(title, closeButton);

  const body = make("div", "trade-history-body");
  body.setAttribute("aria-live", "polite");
  dialog.append(header, body);
  overlay.appendChild(dialog);
  parent.appendChild(overlay);

  let generation = 0;
  let loading = false;
  let cursor: string | null = null;
  let items: TradeHistoryItem[] = [];
  let loadedCursors = new Set<string>();
  let returnFocus: HTMLElement | null = null;

  const formatSol = (base: number): string => `${(base / 1e9).toFixed(3)} SOL`;
  const formatPrice = (value: number): string => value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
  const isCurrent = (run: number): boolean => generation === run && !overlay.hidden;

  const renderStatus = (message: string, error = false): void => {
    body.replaceChildren();
    body.setAttribute("aria-busy", loading ? "true" : "false");
    const status = make(
      "p",
      `trade-history-status${error ? " trade-history-error" : ""}`,
      message,
    );
    body.appendChild(status);
  };

  const renderTrade = (trade: TradeHistoryItem): HTMLElement => {
    const row = make("article", "trade-history-row");
    row.dataset.tradeId = trade.id;
    row.tabIndex = -1;

    const date = make("time", "trade-history-date");
    date.dateTime = trade.settledAt;
    date.textContent = new Date(trade.settledAt).toLocaleString();

    const side = trade.dir === 1 ? "LONG" : "SHORT";
    const main = make(
      "div",
      "trade-history-main",
      `${trade.asset} · ${side} · Leverage ${trade.lev}× · ${String(trade.outcome).toUpperCase()}`,
    );

    const values = make("div", "trade-history-values");
    values.append(
      make("span", "trade-history-stake", `Stake ${formatSol(trade.stakeBase)}`),
      make(
        "span",
        "trade-history-prices",
        `${formatPrice(trade.entryPrice)} → ${formatPrice(trade.exitPrice)}`,
      ),
      make("span", "trade-history-payout", `Payout ${formatSol(trade.payoutBase)}`),
    );

    const pnlClass = trade.pnlBase > 0
      ? "trade-history-pnl--positive"
      : trade.pnlBase < 0
        ? "trade-history-pnl--negative"
        : "trade-history-pnl--flat";
    const pnlSign = trade.pnlBase >= 0 ? "+" : "-";
    values.appendChild(make(
      "span",
      `trade-history-pnl ${pnlClass}`,
      `P&L ${pnlSign}${formatSol(Math.abs(trade.pnlBase))}`,
    ));

    row.append(date, main, values);
    return row;
  };

  const renderList = (options: {
    loadingMore?: boolean;
    error?: boolean;
    retryCursor?: string;
    retryAppend?: boolean;
  } = {}): void => {
    body.replaceChildren();
    body.setAttribute("aria-busy", loading ? "true" : "false");

    for (const trade of items) body.appendChild(renderTrade(trade));

    if (options.error) {
      const message = make("p", "trade-history-status trade-history-error", "Could not load history.");
      const retry = make("button", "trade-history-button trade-history-retry", "Retry");
      retry.type = "button";
      retry.dataset.history = "retry";
      const run = generation;
      retry.addEventListener("click", () => {
        void loadPage(options.retryCursor, options.retryAppend ?? false, run, true);
      });
      body.append(message, retry);
      return;
    }

    if (!items.length) {
      body.appendChild(make("p", "trade-history-status", "No settled trades yet."));
      return;
    }

    if (options.loadingMore) {
      const pending = make("button", "trade-history-button trade-history-more", "Loading more…");
      pending.type = "button";
      pending.disabled = true;
      body.appendChild(pending);
      return;
    }

    if (cursor) {
      const next = cursor;
      const run = generation;
      const more = make("button", "trade-history-button trade-history-more", "Load more");
      more.type = "button";
      more.dataset.history = "more";
      more.addEventListener("click", () => { void loadPage(next, true, run, true); });
      body.appendChild(more);
    }
  };

  async function loadPage(
    next: string | undefined,
    append: boolean,
    run: number,
    focusAfter = false,
  ): Promise<void> {
    if (!isCurrent(run) || loading) return;

    const focusIndex = append ? items.length : 0;
    loading = true;
    if (append) renderList({ loadingMore: true });
    else renderStatus("Loading history…");

    try {
      const page = await deps.load(next);
      if (!isCurrent(run)) return;

      loading = false;
      if (append && next) loadedCursors.add(next);
      items = uniqueTrades(append ? items : [], page.items);
      cursor = page.nextCursor && !loadedCursors.has(page.nextCursor) ? page.nextCursor : null;
      renderList();
      if (focusAfter) {
        const rows = body.querySelectorAll<HTMLElement>("[data-trade-id]");
        const target = rows[focusIndex]
          ?? body.querySelector<HTMLButtonElement>('[data-history="more"]')
          ?? closeButton;
        target.focus();
      }
    } catch {
      if (!isCurrent(run)) return;

      loading = false;
      renderList({ error: true, retryCursor: next, retryAppend: append });
      if (focusAfter) body.querySelector<HTMLButtonElement>('[data-history="retry"]')?.focus();
    }
  }

  const close = (): void => {
    if (overlay.hidden) return;

    generation += 1;
    loading = false;
    overlay.hidden = true;
    body.replaceChildren();
    body.setAttribute("aria-busy", "false");

    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected) target.focus();
  };

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  doc.addEventListener("keydown", (event) => {
    if (overlay.hidden || !overlay.isConnected) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])",
    ].join(","))).filter((element) => {
      const style = doc.defaultView?.getComputedStyle(element);
      return element.tabIndex >= 0
        && !element.closest("[hidden]")
        && element.getAttribute("aria-hidden") !== "true"
        && style?.display !== "none"
        && style?.visibility !== "hidden";
    });

    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    async open(): Promise<void> {
      const wasClosed = overlay.hidden;
      if (wasClosed) {
        const active = doc.activeElement;
        returnFocus = active && typeof (active as HTMLElement).focus === "function"
          ? active as HTMLElement
          : null;
      }

      const run = ++generation;
      loading = false;
      cursor = null;
      items = [];
      loadedCursors = new Set<string>();
      overlay.hidden = false;
      closeButton.focus();

      if (!deps.signedIn()) {
        renderStatus("Sign in to view your trade history.");
        return;
      }

      loading = true;
      renderStatus("Loading history…");
      loading = false;
      try {
        await deps.flush();
      } catch {
        // A failed local queue flush must not hide history already stored by the API.
      }
      if (!isCurrent(run)) return;
      await loadPage(undefined, false, run);
    },
    close,
    isOpen: () => !overlay.hidden,
  };
}
