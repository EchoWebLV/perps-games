import { qrMatrix, qrSvg } from "./qr";

/**
 * Wallet page — a full-screen synthwave overlay opened from the balance chip.
 *
 * SOL-native, on-chain only: the player funds their own wallet (the Privy embedded wallet,
 * or the dev keypair) by sending native SOL to the address shown here (QR + copy). The first
 * GO wraps that SOL into the on-chain play balance. The panel shows the play balance and the
 * End-session / Withdraw controls. There is no "connect wallet" — you're already signed in via
 * the on-chain session — and no off-chain USDC deposit.
 *
 * The address + balance run through callbacks so main owns auth and on-chain reads.
 */
export interface Wallet {
  open(): void;
  setBalance(b: number): void;
  /** hide/close during a live round (reached only when not driving) */
  setBusy(busy: boolean): void;
}

export interface WalletOpts {
  /** The on-chain session wallet address — CALLED on every open (a Privy wallet only exists
   *  after login). Returns "" before the wallet is ready (pre-login). */
  address: () => string;
  /** Displayed balance in centi-SOL units (1 unit = 0.01 SOL) — the on-chain play balance. */
  balance: () => number;
  /** The wallet's OWN native SOL (in SOL), read fresh on every open — so a deposit visibly
   *  arrives before the first GO moves it into the play balance. null/absent = don't show. */
  fetchWalletSol?: () => Promise<number | null>;
  /**
   * On-chain controls. `status()` is read on every open/refresh: `playCents` = the on-chain play
   * balance in centi-SOL units; `delegated` is kept for internal bookkeeping only (NOT surfaced to
   * the player). `cashOut()` is the single player action — it quietly undelegates any live ER
   * session and withdraws to the wallet, so the player never sees the session lifecycle.
   */
  onchain: {
    status: () => { delegated: boolean; playCents: number };
    cashOut: () => Promise<void>;
  };
  // ── legacy off-chain fields (no longer rendered; kept optional so callers compile) ──
  walletBalance?: () => number | null;
  onConnectWallet?: () => Promise<void>;
  onWalletPoll?: () => Promise<number>;
  onAddToPlay?: () => Promise<void>;
}

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
} as const;
const svg = (d: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
// Solana mark — three slanted bars in the brand teal→purple gradient
const solCoin = (size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><defs><linearGradient id="solg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9945ff"/><stop offset="1" stop-color="#19fb9b"/></linearGradient></defs><circle cx="12" cy="12" r="11" fill="#0b0820"/><g fill="url(#solg)"><path d="M7 8.6c.1-.1.3-.2.4-.2h8.2c.2 0 .3.3.2.4l-1.4 1.5c-.1.1-.3.2-.4.2H6c-.2 0-.3-.3-.2-.4z"/><path d="M7 15.4c.1-.1.3-.2.4-.2h8.2c.2 0 .3.3.2.4l-1.4 1.5c-.1.1-.3.2-.4.2H6c-.2 0-.3-.3-.2-.4z" transform="translate(0,-3.4)"/><path d="M17 12.6c-.1.1-.3.2-.4.2H8.4c-.2 0-.3-.3-.2-.4l1.4-1.5c.1-.1.3-.2.4-.2h8.2c.2 0 .3.3.2.4z"/></g></svg>`;

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

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
    .wlt-hero-top svg{filter:drop-shadow(0 0 6px rgba(153,69,255,.7))}
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

    .wlt-oc{display:flex;flex-direction:column;gap:10px;padding-top:4px;border-top:1px solid rgba(132,150,224,.18)}
    .wlt-oc-btns{display:flex;gap:8px}
    .wlt-oc-btn{flex:1;border:0;cursor:pointer;border-radius:9px;padding:12px 0;
      font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;transition:.13s}
    .wlt-oc-btn.end{color:rgba(255,209,102,.92);background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.35)}
    .wlt-oc-btn.wd{color:var(--cyan);background:rgba(39,231,255,.12);border:1px solid rgba(39,231,255,.38)}
    .wlt-oc-btn:disabled{opacity:.4;cursor:not-allowed}
  `;
  document.head.appendChild(s);
}

export function createWallet(parent: HTMLElement, opts: WalletOpts): Wallet {
  injectStyles();

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
       <div class="wlt-hero-top">${solCoin(22)}<span class="wlt-hero-lbl">Balance</span></div>
       <div class="wlt-bal"><span id="wltBal">0.000</span><span class="wlt-bal-cur">SOL</span></div>
       <div class="wlt-hero-sub">Solana · devnet</div>
     </div>` +
    // recv view is filled live by renderAddressUI() on each open — a Privy address only exists
    // AFTER login, so it must be read fresh, never snapshotted at build time.
    `<div class="wlt-view" id="wltRecv"></div>` +
    `<div id="wltOnchain"></div>`;

  const q = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const balEl = q("#wltBal");
  const heroSub = q(".wlt-hero-sub");

  // Breakdown line under the total: wallet SOL vs money currently in play. Refreshed on
  // every open — deposits show up here (and in the total) before the first GO.
  const renderWalletSol = () => {
    if (!opts.fetchWalletSol) return;
    void opts.fetchWalletSol().then((sol) => {
      if (sol == null) { heroSub.textContent = "Solana · devnet"; return; }
      const inPlay = opts.onchain.status().playCents / 100;
      heroSub.textContent = `Solana · devnet · wallet ${fmt(sol)} · in play ${fmt(inPlay)}`;
    }).catch(() => { /* keep the plain network line */ });
  };

  let busy = false;

  const renderBalance = (bump = false) => {
    balEl.textContent = fmt(opts.balance() / 100); // centi-SOL units → SOL
    if (bump) { balEl.parentElement!.classList.remove("bump"); void balEl.offsetWidth; balEl.parentElement!.classList.add("bump"); }
  };

  // Re-render the Receive QR + address from the live wallet address on every open. A Privy
  // address only exists after login, so a build-time snapshot would never appear; an empty
  // address shows a "wallet loading" hint instead of a sendable address.
  const renderAddressUI = () => {
    const addr = opts.address();
    const recv = q<HTMLElement>("#wltRecv");
    if (addr) {
      const qr = qrSvg(qrMatrix(addr, "M"), { dark: "#0a0820", light: "#ffffff", margin: 3 });
      recv.innerHTML =
        `<div class="wlt-qr-wrap"><div class="wlt-qr">${qr}</div></div>` +
        `<div class="wlt-net">${solCoin(15)} SOL · Solana devnet</div>` +
        `<div class="wlt-addr"><span title="${addr}">${shortAddr(addr)}</span><button class="wlt-copy" id="wltCopy">${svg(ICONS.copy, 13)}Copy</button></div>` +
        `<div class="wlt-note wlt-warn">Send SOL to this address to fund your wallet. Your first GO wraps it into your play balance.</div>`;
      const copyBtn = recv.querySelector<HTMLButtonElement>("#wltCopy");
      if (copyBtn) {
        let copyTimer = 0;
        copyBtn.onclick = async () => {
          try { await navigator.clipboard?.writeText(addr); } catch { /* clipboard unavailable */ }
          copyBtn.classList.add("done");
          copyBtn.innerHTML = `${svg(ICONS.check, 13)}Copied`;
          clearTimeout(copyTimer);
          copyTimer = window.setTimeout(() => { copyBtn.classList.remove("done"); copyBtn.innerHTML = `${svg(ICONS.copy, 13)}Copy`; }, 1400);
        };
      }
    } else {
      recv.innerHTML =
        `<div class="wlt-note wlt-warn">Setting up your wallet… sign in if prompted, then reopen this panel to see your deposit address.</div>`;
    }
  };

  const ocEl = q<HTMLElement>("#wltOnchain");
  let ocBusy = false;
  const renderOnchain = () => {
    const { playCents } = opts.onchain.status();
    // One button. "Cash out" moves the whole play balance to the wallet; it handles undelegating a
    // live session under the hood (see main's onchain.cashOut), so there is no player-facing "End".
    ocEl.innerHTML =
      `<div class="wlt-oc">
         <div class="wlt-oc-btns">
           <button class="wlt-oc-btn wd" id="wltOcCash" ${playCents > 0 ? "" : "disabled"}>Cash out to wallet</button>
         </div>
       </div>`;
    const cashBtn = ocEl.querySelector<HTMLButtonElement>("#wltOcCash");
    const run = async (btn: HTMLButtonElement, label: string, fn: () => Promise<void>) => {
      if (ocBusy) return;
      ocBusy = true; btn.disabled = true; const prev = btn.textContent; btn.textContent = label;
      try { await fn(); } catch { /* surfaced by main's status line */ }
      finally { ocBusy = false; btn.textContent = prev ?? ""; renderOnchain(); renderBalance(); }
    };
    if (cashBtn) cashBtn.onclick = () => void run(cashBtn, "Cashing out…", opts.onchain.cashOut);
  };

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    if (open) {
      renderBalance();
      renderAddressUI();
      renderOnchain();
      renderWalletSol();
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
    setBalance() { renderBalance(); renderOnchain(); },
    setBusy(b) { busy = b; if (b) setOpen(false); },
  };
}
