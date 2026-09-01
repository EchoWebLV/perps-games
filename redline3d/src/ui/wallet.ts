import { qrMatrix, qrSvg } from "./qr";
import { ACTIVE_STAKE_CURRENCY, type StakeCurrency } from "../core/stake-currency";

/**
 * Cashier page — a full-screen synthwave overlay opened from the balance chip.
 *
 * Server-ledger native, Robinhood Chain rail. The hero is the player's CASH BALANCE as the
 * server holds it (cents); the two actions move money across the boundary:
 *   • Add funds — an ERC-20 USDC transfer from the player's own embedded wallet to the
 *     treasury. It lands in the ledger once the server's confirmer sees it on-chain.
 *   • Cash out — a withdrawal request against the ledger. The server pays the wallet it
 *     BOUND to this account, so no address is ever posted from the client.
 * Below the deposit stepper sits the player's own address (QR + copy) — that is where USDC
 * (and a little ETH for gas) has to arrive before a deposit can be sent at all.
 *
 * Everything runs through callbacks so main owns auth, the chain port, and the API.
 */
export interface Wallet {
  open(): void;
  setBalance(b: number): void;
  /** hide/close during a live round (reached only when not driving) */
  setBusy(busy: boolean): void;
}

export interface WalletOpts {
  currency?: StakeCurrency;
  /** the bound EVM wallet address (Privy embedded) — funding target for bridged USDC + gas.
   *  CALLED on every open: a Privy wallet only exists after login, so "" before sign-in. */
  address: () => string;
  /** server ledger cash balance in cents. */
  balance: () => number;
  /** wallet's own USDC (base units) — shows a deposit arriving before it is moved in. */
  fetchWalletUsdc?: () => Promise<bigint | null>;
  deposit: {
    minCents: number; maxCents: number;
    /** ERC-20 transfer from the embedded wallet to the treasury; resolves the tx hash. */
    send: (amountCents: number) => Promise<string>;
  };
  withdraw: { minCents: number; maxCents: number; request: (amountCents: number) => Promise<void> };
}

/** USDC is a 6-decimal token on Robinhood Chain; the ledger is cents. Only display math here. */
const USDC_DECIMALS = 6;
/** Both steppers move in whole dollars — the deposit/withdraw bounds are dollar-sized. */
const STEP_CENTS = 100;
const NETWORK_LINE = "Robinhood Chain";

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
} as const;
const svg = (d: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
// USDC mark — the dollar glyph on the stablecoin's blue disc
const usdcCoin = (size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#2775ca"/><path d="M12 5.4v1.3m0 10.6v1.3" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M14.7 9.1c-.3-1.1-1.4-1.8-2.7-1.8-1.6 0-2.8.8-2.8 2.1 0 1.2.9 1.8 2.6 2.2l.6.1c1.7.4 2.6 1 2.6 2.2 0 1.3-1.2 2.1-2.9 2.1-1.4 0-2.5-.7-2.8-1.9" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .wlt-panel{width:min(390px,94vw);max-height:92vh;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;
      background:rgba(12,10,26,.92);border-color:rgba(132,150,224,.3);pointer-events:auto;-webkit-overflow-scrolling:touch}
    .wlt-head{display:flex;align-items:center;gap:10px}
    .wlt-head .lbl{flex:1}
    .wlt-x{cursor:pointer;color:var(--mut);font:700 16px/1 'Chakra Petch',ui-monospace,monospace;padding:3px 6px;border:0;background:transparent;border-radius:8px}
    .wlt-x:hover{color:var(--ink);background:rgba(255,255,255,.06)}

    /* balance hero — gradient-bordered card with a drifting neon glow */
    .wlt-hero{position:relative;border-radius:15px;padding:17px 18px 16px;overflow:hidden;isolation:isolate;flex:0 0 auto;
      border:1.5px solid transparent;
      background:linear-gradient(165deg,#1a1547,#241a63 48%,#3a1d63) padding-box,
        linear-gradient(135deg,#27e7ff,#9945ff 55%,#19fb9b) border-box;
      box-shadow:0 10px 30px rgba(39,231,255,.16),inset 0 1px 0 rgba(255,255,255,.08)}
    .wlt-hero-glow{position:absolute;inset:-40% -20%;z-index:-1;pointer-events:none;opacity:.5;
      background:radial-gradient(40% 60% at 22% 12%,rgba(39,231,255,.5),transparent 70%),
        radial-gradient(46% 60% at 86% 96%,rgba(153,69,255,.45),transparent 72%);
      animation:wltDrift 9s ease-in-out infinite alternate}
    @keyframes wltDrift{0%{transform:translate(0,0)}100%{transform:translate(-6%,5%)}}
    .wlt-hero-top{display:flex;align-items:center;gap:8px;margin-bottom:7px}
    .wlt-hero-top svg{filter:drop-shadow(0 0 6px rgba(39,231,255,.7))}
    .wlt-hero-lbl{font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:rgba(216,222,255,.78)}
    .wlt-bal{display:flex;align-items:baseline;gap:6px;font:800 42px/1 'Chakra Petch',ui-monospace,monospace;
      color:#fff;letter-spacing:-.01em;font-variant-numeric:tabular-nums;text-shadow:0 0 22px rgba(39,231,255,.45);transform-origin:left center}
    .wlt-bal-cur{font-size:22px;color:rgba(255,255,255,.7)}
    .wlt-bal.bump{animation:wltBump .5s cubic-bezier(.2,.8,.3,1)}
    @keyframes wltBump{0%{transform:scale(1)}30%{transform:scale(1.09);text-shadow:0 0 30px rgba(46,230,166,.8)}100%{transform:scale(1)}}
    .wlt-hero-sub{margin-top:6px;font:600 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.04em;color:rgba(216,222,255,.62)}

    .wlt-view{display:flex;flex-direction:column;gap:13px}

    .wlt-note{font:500 10.5px/1.5 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:rgba(216,222,255,.55);text-align:center}
    .wlt-note.wlt-warn{color:rgba(255,209,102,.82)}

    /* money sections — Add funds / Cash out */
    .wlt-sec{display:flex;flex-direction:column;gap:10px;padding-top:11px;border-top:1px solid rgba(132,150,224,.18)}
    .wlt-sec-lbl{font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:rgba(216,222,255,.7)}
    .wlt-step{display:flex;align-items:center;gap:9px}
    .wlt-step-btn{width:38px;flex:0 0 auto;border:1px solid rgba(132,150,224,.3);background:rgba(7,5,18,.65);color:var(--ink);
      cursor:pointer;border-radius:9px;padding:11px 0;font:800 15px/1 'Chakra Petch',ui-monospace,monospace}
    .wlt-step-btn:hover{background:rgba(39,231,255,.12);border-color:rgba(39,231,255,.38)}
    .wlt-step-val{flex:1;text-align:center;font:800 20px/1 'Chakra Petch',ui-monospace,monospace;color:#fff;font-variant-numeric:tabular-nums}
    .wlt-act{border:0;cursor:pointer;border-radius:9px;padding:12px 0;width:100%;
      font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;transition:.13s;
      color:var(--cyan);background:rgba(39,231,255,.12);border:1px solid rgba(39,231,255,.38)}
    .wlt-act:hover{background:rgba(39,231,255,.2)}
    .wlt-act:disabled{opacity:.4;cursor:not-allowed}
    .wlt-status{min-height:13px;font:500 10.5px/1.4 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:rgba(46,230,166,.85);text-align:center}

    /* Receive — QR card + address row */
    .wlt-qr-wrap{display:flex;justify-content:center;padding:2px}
    .wlt-qr{width:188px;height:188px;padding:13px;border-radius:14px;background:#fff;
      box-shadow:0 0 0 1.5px rgba(39,231,255,.55),0 0 26px rgba(39,231,255,.32),0 10px 24px rgba(0,0,0,.5)}
    .wlt-net{display:flex;align-items:center;justify-content:center;gap:7px;
      font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:rgba(216,222,255,.72)}
    .wlt-addr{display:flex;align-items:center;gap:9px;padding:11px 12px;border-radius:11px;
      background:rgba(7,5,18,.65);border:1px solid rgba(132,150,224,.24)}
    .wlt-addr span{flex:1;min-width:0;font:600 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.03em;color:var(--ink);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .wlt-copy{display:flex;align-items:center;gap:6px;border:0;cursor:pointer;border-radius:8px;padding:8px 12px;
      font:700 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;
      color:var(--cyan);background:rgba(39,231,255,.12);border:1px solid rgba(39,231,255,.38);transition:.13s}
    .wlt-copy:hover{background:rgba(39,231,255,.2)}
    .wlt-copy.done{color:#04130d;background:linear-gradient(180deg,#5ff0c0,#15c78c);border-color:transparent}
  `;
  document.head.appendChild(s);
}

export function createWallet(parent: HTMLElement, opts: WalletOpts): Wallet {
  injectStyles();
  const currency = opts.currency ?? ACTIVE_STAKE_CURRENCY;
  // The ledger's display unit IS the dollar here (cents / 10^displayUnitDecimals).
  const money = (cents: number) => (cents / 10 ** currency.displayUnitDecimals).toFixed(2);
  const usdc = (base: bigint) => (Number(base) / 10 ** USDC_DECIMALS).toFixed(2);

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:10", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.82)", "backdrop-filter:blur(3px)", "pointer-events:auto",
  ].join(";");

  const panel = document.createElement("div");
  panel.className = "panel wlt-panel";
  panel.innerHTML =
    `<div class="wlt-head"><span class="lbl">wallet</span><button class="wlt-x" data-act="close" aria-label="Close">✕</button></div>` +
    `<div class="wlt-hero"><div class="wlt-hero-glow"></div>
       <div class="wlt-hero-top">${usdcCoin(22)}<span class="wlt-hero-lbl">Balance</span></div>
       <div class="wlt-bal"><span id="wltBal">0.00</span><span class="wlt-bal-cur">${currency.symbol}</span></div>
       <div class="wlt-hero-sub">${NETWORK_LINE}</div>
     </div>` +
    // Both money sections are filled live on each open — the deposit address only exists AFTER
    // login, and the cash-out button's enabled state tracks the balance.
    `<div id="wltDeposit"></div>` +
    `<div class="wlt-view" id="wltRecv"></div>` +
    `<div id="wltWithdraw"></div>`;

  const q = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const balEl = q("#wltBal");
  const heroSub = q(".wlt-hero-sub");
  const depEl = q<HTMLElement>("#wltDeposit");
  const wdEl = q<HTMLElement>("#wltWithdraw");

  let depCents = clamp(opts.deposit.minCents, opts.deposit.minCents, opts.deposit.maxCents);
  let wdCents = clamp(opts.withdraw.minCents, opts.withdraw.minCents, opts.withdraw.maxCents);
  let busy = false;
  let moving = false; // a deposit/withdrawal is in flight — one money action at a time

  // Breakdown line under the total: what the player's OWN wallet holds. Refreshed on every open,
  // so USDC that arrived on-chain shows up here before it has been moved into the ledger.
  const renderWalletUsdc = () => {
    if (!opts.fetchWalletUsdc) { heroSub.textContent = NETWORK_LINE; return; }
    void opts.fetchWalletUsdc().then((base) => {
      heroSub.textContent = base == null ? NETWORK_LINE : `${NETWORK_LINE} · wallet ${usdc(base)} USDC`;
    }).catch(() => { /* keep the plain network line */ });
  };

  const renderBalance = (bump = false) => {
    balEl.textContent = money(opts.balance());
    if (bump) { balEl.parentElement!.classList.remove("bump"); void balEl.offsetWidth; balEl.parentElement!.classList.add("bump"); }
  };

  // One shared stepper renderer for Add funds / Cash out: ± buttons around a dollar readout, an
  // action button, and a status line. `run` owns the in-flight lock so neither can double-fire.
  function renderStepper(host: HTMLElement, cfg: {
    key: "Dep" | "Wd";
    label: string;
    action: string;
    value: () => number;
    setValue: (cents: number) => void;
    min: number; max: number;
    disabled: boolean;
    busyLabel: string;
    run: (cents: number) => Promise<string>;
  }) {
    const status = (host.querySelector(`#wlt${cfg.key}Status`) as HTMLElement | null)?.textContent ?? "";
    host.innerHTML =
      `<div class="wlt-sec">
         <span class="wlt-sec-lbl">${cfg.label}</span>
         <div class="wlt-step">
           <button class="wlt-step-btn" id="wlt${cfg.key}Dn" aria-label="Less">−</button>
           <span class="wlt-step-val" id="wlt${cfg.key}Val">$${money(cfg.value())}</span>
           <button class="wlt-step-btn" id="wlt${cfg.key}Up" aria-label="More">+</button>
         </div>
         <button class="wlt-act" id="wlt${cfg.key}Go"${cfg.disabled ? " disabled" : ""}>${cfg.action}</button>
         <div class="wlt-status" id="wlt${cfg.key}Status">${status}</div>
       </div>`;
    const valEl = host.querySelector(`#wlt${cfg.key}Val`) as HTMLElement | null;
    const statusEl = host.querySelector(`#wlt${cfg.key}Status`) as HTMLElement | null;
    const goBtn = host.querySelector(`#wlt${cfg.key}Go`) as HTMLButtonElement | null;
    // Re-assert the two live texts as PROPERTIES, not just markup: a re-render (after a
    // deposit/withdrawal) must carry the stepper's amount and the last status forward.
    if (valEl) valEl.textContent = `$${money(cfg.value())}`;
    if (statusEl) statusEl.textContent = status;
    if (goBtn) goBtn.textContent = cfg.action;
    const step = (delta: number) => {
      if (moving) return;
      cfg.setValue(clamp(cfg.value() + delta * STEP_CENTS, cfg.min, cfg.max));
      if (valEl) valEl.textContent = `$${money(cfg.value())}`;
    };
    const dn = host.querySelector(`#wlt${cfg.key}Dn`) as HTMLElement | null;
    const up = host.querySelector(`#wlt${cfg.key}Up`) as HTMLElement | null;
    if (dn) dn.onclick = () => step(-1);
    if (up) up.onclick = () => step(1);
    if (goBtn) {
      goBtn.onclick = async () => {
        if (moving || cfg.disabled) return;
        moving = true;
        goBtn.disabled = true;
        const prev = goBtn.textContent;
        goBtn.textContent = cfg.busyLabel;
        try {
          const msg = await cfg.run(cfg.value());
          if (statusEl) statusEl.textContent = msg;
        } catch (e) {
          if (statusEl) statusEl.textContent = String((e as Error)?.message ?? e) || "That didn't go through — try again.";
        } finally {
          moving = false;
          goBtn.textContent = prev ?? cfg.action;
          renderBalance();
          renderMoney();
          renderWalletUsdc();
        }
      };
    }
  }

  const DEPOSIT_CONFIRMATIONS = 2; // the server credits the ledger once its confirmer sees the transfer
  function renderMoney() {
    renderStepper(depEl, {
      key: "Dep",
      label: "Add funds",
      action: "Deposit",
      value: () => depCents,
      setValue: (c) => { depCents = c; },
      min: opts.deposit.minCents,
      max: opts.deposit.maxCents,
      // funding needs an address to send FROM; before login there is nothing to spend
      disabled: !opts.address(),
      busyLabel: "Sending…",
      run: async (cents) => {
        await opts.deposit.send(cents);
        return `Deposit sent — it lands after ${DEPOSIT_CONFIRMATIONS} confirmations`;
      },
    });
    renderStepper(wdEl, {
      key: "Wd",
      label: "Cash out",
      action: "Cash out to wallet",
      value: () => wdCents,
      setValue: (c) => { wdCents = c; },
      min: opts.withdraw.minCents,
      max: opts.withdraw.maxCents,
      // nothing to send: the server would refuse anything under its own minimum anyway
      disabled: opts.balance() < opts.withdraw.minCents,
      busyLabel: "Requesting…",
      run: async (cents) => {
        await opts.withdraw.request(cents);
        return "Withdrawal requested — arrives after review.";
      },
    });
  }

  // Re-render the funding QR + address from the live wallet address on every open. A Privy
  // address only exists after login, so a build-time snapshot would never appear; an empty
  // address shows a "wallet loading" hint instead of a sendable address.
  const renderAddressUI = () => {
    const addr = opts.address();
    const recv = q<HTMLElement>("#wltRecv");
    if (!addr) {
      recv.innerHTML =
        `<div class="wlt-note wlt-warn">Setting up your wallet… sign in if prompted, then reopen this panel to see your deposit address.</div>`;
      return;
    }
    const qr = qrSvg(qrMatrix(addr, "M"), { dark: "#0a0820", light: "#ffffff", margin: 3 });
    recv.innerHTML =
      `<div class="wlt-qr-wrap"><div class="wlt-qr">${qr}</div></div>` +
      `<div class="wlt-net">${usdcCoin(15)} USDC · ${NETWORK_LINE}</div>` +
      `<div class="wlt-addr"><span title="${addr}">${shortAddr(addr)}</span><button class="wlt-copy" id="wltCopy">${svg(ICONS.copy, 13)}Copy</button></div>` +
      `<div class="wlt-note wlt-warn">Fund this wallet with USDC on Robinhood Chain (plus a little ETH for gas).</div>`;
    const copyBtn = recv.querySelector<HTMLButtonElement>("#wltCopy");
    if (!copyBtn) return;
    let copyTimer = 0;
    copyBtn.onclick = async () => {
      try { await navigator.clipboard?.writeText(addr); } catch { /* clipboard unavailable */ }
      copyBtn.classList.add("done");
      copyBtn.innerHTML = `${svg(ICONS.check, 13)}Copied`;
      clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => { copyBtn.classList.remove("done"); copyBtn.innerHTML = `${svg(ICONS.copy, 13)}Copy`; }, 1400);
    };
  };

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    if (open) {
      renderBalance();
      renderMoney();
      renderAddressUI();
      renderWalletUsdc();
    }
  };
  overlay.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t === overlay || t.closest("[data-act='close']")) setOpen(false);
  };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false); });

  overlay.appendChild(panel);
  parent.appendChild(overlay);

  return {
    open() { if (!busy) setOpen(true); },
    setBalance() { renderBalance(); renderMoney(); },
    setBusy(b) { busy = b; if (b) setOpen(false); },
  };
}
