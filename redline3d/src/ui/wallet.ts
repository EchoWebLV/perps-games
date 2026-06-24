import { qrMatrix, qrSvg } from "./qr";
import { shortWallet } from "./auth-ui";

/**
 * Wallet page — a full-screen synthwave overlay opened from the balance chip.
 *   • USDC balance hero
 *   • Buy USDC (add funds) — preset amounts → credit
 *   • Receive — deposit-address QR + copy
 *
 * The balance and the credit path run through callbacks so main owns the actual
 * Settlement; the address is supplied by the caller (a backend wallet later).
 */
export interface Wallet {
  open(): void;
  setBalance(b: number): void;
  /** hide/close during a live round (reached only when not driving) */
  setBusy(busy: boolean): void;
}

export interface WalletOpts {
  /** Current deposit address — CALLED on every open so it reflects a wallet that only exists
   *  after login. Returns "" when there is no real wallet yet (dev/guest, or pre-login). */
  address: () => string;
  balance: () => number;
  /** on-chain USDC currently held by the embedded Privy wallet, in cents */
  walletBalance?: () => number | null;
  /** credit `usd` USDC to the balance (sim deposit today, fiat on-ramp later) */
  onBuy: (usd: number) => void;
  /** sign the player out — when omitted (dev/guest) the account row stays hidden */
  onLogout?: () => void;
  /** real deposit: build + sign + broadcast a USDC transfer for `cents`; resolves to the signature.
   *  Does NOT credit — the server confirmer does; the UI polls onPoll() for the credited balance. */
  onDeposit?: (cents: number) => Promise<string>;
  /** re-fetch the server balance (cents). Used to poll for the credited deposit after broadcast. */
  onPoll?: () => Promise<number>;
  /** re-fetch the on-chain Privy wallet USDC balance, in cents */
  onWalletPoll?: () => Promise<number>;
}

const AMOUNTS = [10, 25, 50, 100, 250];

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2M20 14v6M14 18v2h2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
} as const;
const svg = (d: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
// the USDC token glyph (filled coin) — drawn so it reads even at small sizes
const usdcCoin = (size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="#2775ca"/><path d="M12 5.4v1.1m0 11v1.1" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><path d="M12 7.2c-1.7 0-3 .9-3 2.3 0 1.2.9 1.8 2.7 2.2 1.8.4 2.3.8 2.3 1.5 0 .8-.8 1.3-2 1.3-1.4 0-2.2-.6-2.4-1.6M12 7.2c1.3 0 2.1.5 2.4 1.5M12 7.2V6m0 10.8c1.7 0 3-.9 3-2.3" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        linear-gradient(135deg,#27e7ff,#ff39c0 55%,#2775ca) border-box;
      box-shadow:0 10px 30px rgba(39,231,255,.16),inset 0 1px 0 rgba(255,255,255,.08)}
    .wlt-hero-glow{position:absolute;inset:-40% -20%;z-index:-1;pointer-events:none;opacity:.5;
      background:radial-gradient(40% 60% at 22% 12%,rgba(39,231,255,.5),transparent 70%),
        radial-gradient(46% 60% at 86% 96%,rgba(255,57,192,.45),transparent 72%);
      animation:wltDrift 9s ease-in-out infinite alternate}
    @keyframes wltDrift{0%{transform:translate(0,0)}100%{transform:translate(-6%,5%)}}
    .wlt-hero-top{display:flex;align-items:center;gap:8px;margin-bottom:7px}
    .wlt-hero-top svg{filter:drop-shadow(0 0 6px rgba(39,118,202,.7))}
    .wlt-hero-lbl{font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:rgba(216,222,255,.78)}
    .wlt-bal{display:flex;align-items:baseline;gap:1px;font:800 42px/1 'Chakra Petch',ui-monospace,monospace;
      color:#fff;letter-spacing:-.01em;font-variant-numeric:tabular-nums;text-shadow:0 0 22px rgba(39,231,255,.45);transform-origin:left center}
    .wlt-bal-cur{font-size:24px;color:rgba(255,255,255,.7);margin-right:2px;align-self:flex-start;margin-top:4px}
    .wlt-bal.bump{animation:wltBump .5s cubic-bezier(.2,.8,.3,1)}
    @keyframes wltBump{0%{transform:scale(1)}30%{transform:scale(1.09);text-shadow:0 0 30px rgba(46,230,166,.8)}100%{transform:scale(1)}}
    .wlt-hero-sub{margin-top:6px;font:600 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.04em;color:rgba(216,222,255,.62)}

    /* Buy / Receive segmented control */
    .wlt-seg{display:flex;gap:6px;padding:4px;border-radius:12px;background:rgba(7,5,18,.6);border:1px solid rgba(132,150,224,.2)}
    .wlt-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 0;border:0;cursor:pointer;border-radius:9px;
      font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;
      color:var(--mut);background:transparent;transition:color .15s,background .15s}
    .wlt-tab.on{color:#04101a;background:linear-gradient(180deg,#54e0ff,#27a7e7);box-shadow:0 4px 14px rgba(39,167,231,.35)}
    .wlt-view{display:flex;flex-direction:column;gap:13px}
    .wlt-view[hidden]{display:none}

    /* Buy amounts */
    .wlt-amts{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
    .wlt-amt{padding:13px 0;border-radius:11px;cursor:pointer;text-align:center;
      font:800 16px/1 'Chakra Petch',ui-monospace,monospace;font-variant-numeric:tabular-nums;
      color:var(--ink);background:rgba(18,14,40,.72);border:1.5px solid rgba(132,150,224,.24);transition:.13s ease}
    .wlt-amt small{display:block;margin-top:4px;font:600 8.5px/1 'Chakra Petch';letter-spacing:.12em;color:var(--mut);text-transform:uppercase}
    .wlt-amt:hover{border-color:rgba(39,231,255,.5)}
    .wlt-amt.on{color:#04101a;background:linear-gradient(180deg,#bfeeff,#7fd6ff);border-color:transparent;box-shadow:0 0 0 1px rgba(39,231,255,.5),0 6px 16px rgba(39,231,255,.28)}
    .wlt-amt.on small{color:rgba(4,16,26,.6)}

    /* the buy CTA — chamfered arcade button in USDC blue→cyan */
    .wlt-cta{width:100%;border:0;padding:15px;cursor:pointer;position:relative;
      font:800 16px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#04101a;
      background:linear-gradient(180deg,#5fe3ff,#2775ca);
      clip-path:polygon(13px 0,100% 0,100% calc(100% - 13px),calc(100% - 13px) 100%,0 100%,0 13px);
      filter:drop-shadow(0 9px 20px rgba(39,118,202,.42));transition:transform .06s ease,filter .15s}
    .wlt-cta::after{content:"";position:absolute;inset:0;clip-path:inherit;pointer-events:none;
      background:linear-gradient(180deg,rgba(255,255,255,.38),transparent 46%)}
    .wlt-cta:active{transform:translateY(1px)}
    .wlt-cta.ok{background:linear-gradient(180deg,#5ff0c0,#15c78c);filter:drop-shadow(0 9px 20px rgba(46,230,166,.45))}

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
    .wlt-wallet-bal{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;
      background:rgba(18,14,40,.58);border:1px solid rgba(132,150,224,.2)}
    .wlt-wallet-bal span{font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
    .wlt-wallet-bal strong{font:800 14px/1 'Chakra Petch',ui-monospace,monospace;color:var(--ink);font-variant-numeric:tabular-nums}

    /* Deposit-to-game block — real USDC transfer (user wallet → treasury) */
    .wlt-dep{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;
      background:rgba(7,5,18,.6);border:1px solid rgba(132,150,224,.22)}
    .wlt-dep-lbl{font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
    .wlt-dep-row{display:flex;align-items:center;gap:8px}
    .wlt-dep-amt{flex:1;min-width:0;display:flex;align-items:center;gap:4px;padding:10px 12px;border-radius:10px;
      background:rgba(18,14,40,.72);border:1.5px solid rgba(132,150,224,.24)}
    .wlt-dep-amt .cur{font:800 16px/1 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.7)}
    .wlt-dep-amt input{flex:1;min-width:0;border:0;outline:0;background:transparent;
      font:800 18px/1 'Chakra Petch',ui-monospace,monospace;font-variant-numeric:tabular-nums;color:var(--ink)}
    .wlt-dep-btn{flex:0 0 auto;border:0;cursor:pointer;border-radius:10px;padding:12px 16px;
      font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#04101a;
      background:linear-gradient(180deg,#5fe3ff,#2775ca);box-shadow:0 6px 16px rgba(39,118,202,.35);transition:transform .06s ease,filter .15s,opacity .15s}
    .wlt-dep-btn:active{transform:translateY(1px)}
    .wlt-dep-btn:disabled{cursor:default;opacity:.55;filter:grayscale(.3)}
    .wlt-dep-btn.ok{background:linear-gradient(180deg,#5ff0c0,#15c78c)}
    .wlt-dep-status{font:600 10.5px/1.4 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:rgba(216,222,255,.6);min-height:14px}
    .wlt-dep-status.err{color:rgba(255,107,107,.9)}
    .wlt-dep-status.ok{color:rgba(46,230,166,.9)}

    /* Account row — signed-in address + log out (hidden for dev/guest) */
    .wlt-acct{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:11px;
      background:rgba(7,5,18,.6);border:1px solid rgba(132,150,224,.2)}
    .wlt-acct-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
    .wlt-acct-lbl{font:700 8.5px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
    .wlt-acct-addr{font:600 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.03em;color:var(--ink);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .wlt-logout{flex:0 0 auto;border:0;cursor:pointer;border-radius:8px;padding:8px 12px;
      font:700 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;
      color:rgba(255,209,102,.9);background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.35);transition:.13s}
    .wlt-logout:hover{background:rgba(255,209,102,.18)}
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
       <div class="wlt-hero-top">${usdcCoin(22)}<span class="wlt-hero-lbl">Playable balance</span></div>
       <div class="wlt-bal"><span class="wlt-bal-cur">$</span><span id="wltBal">0.00</span></div>
       <div class="wlt-hero-sub"><span id="wltUsdc">0.00</span> USDC staked in game vault</div>
     </div>` +
    `<div class="wlt-seg">
       <button class="wlt-tab on" data-tab="buy">${svg(ICONS.plus, 15)}Buy</button>
       <button class="wlt-tab" data-tab="recv">${svg(ICONS.qr, 15)}Receive</button>
     </div>` +
    `<div class="wlt-view" data-view="buy">
       <div class="wlt-amts">${AMOUNTS.map((a) => `<button class="wlt-amt" data-amt="${a}">$${a}<small>USDC</small></button>`).join("")}</div>
       <button class="wlt-cta" id="wltBuy">Buy USDC</button>
       <div class="wlt-note">Demo deposit. Funds are added instantly to your balance.</div>
     </div>` +
    // recv view + account row are filled live by renderAddressUI() on each open — the deposit
    // address only exists AFTER login, so it must be read fresh, never snapshotted at build time.
    `<div class="wlt-view" data-view="recv" hidden></div>` +
    `<div id="wltAcct"></div>`;

  const q = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const balEl = q("#wltBal"), usdcEl = q("#wltUsdc"), buyBtn = q<HTMLButtonElement>("#wltBuy");
  const views = Array.from(panel.querySelectorAll<HTMLElement>(".wlt-view"));
  const tabs = Array.from(panel.querySelectorAll<HTMLElement>(".wlt-tab"));
  const amtBtns = Array.from(panel.querySelectorAll<HTMLElement>(".wlt-amt"));

  let amount = 50;
  let busy = false;

  const renderBalance = (bump = false) => {
    const b = opts.balance() / 100; // balance is in cents (1 coin = $0.01)
    balEl.textContent = fmt(b);
    usdcEl.textContent = fmt(b);
    if (bump) { balEl.parentElement!.classList.remove("bump"); void balEl.offsetWidth; balEl.parentElement!.classList.add("bump"); }
  };
  const renderAmount = () => {
    amtBtns.forEach((b) => b.classList.toggle("on", Number(b.dataset.amt) === amount));
    if (!buyBtn.classList.contains("ok")) buyBtn.textContent = `Buy $${amount} USDC`;
  };
  renderAmount();

  const walletBalanceText = (cents: number | null | undefined) =>
    cents == null ? "Checking..." : `$${fmt(cents / 100)} USDC`;
  const renderWalletBalance = (recv: HTMLElement, cents = opts.walletBalance?.()) => {
    const el = recv.querySelector<HTMLElement>("#wltWalletBal");
    if (el) el.textContent = walletBalanceText(cents);
  };
  const refreshWalletBalance = async (recv: HTMLElement) => {
    if (!opts.onWalletPoll) { renderWalletBalance(recv); return; }
    renderWalletBalance(recv);
    try { renderWalletBalance(recv, await opts.onWalletPoll()); }
    catch {
      const el = recv.querySelector<HTMLElement>("#wltWalletBal");
      if (el) el.textContent = "Unavailable";
    }
  };

  amtBtns.forEach((b) => (b.onclick = () => { amount = Number(b.dataset.amt); renderAmount(); }));

  const showTab = (tab: string) => {
    tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
    views.forEach((v) => (v.hidden = v.dataset.view !== (tab === "recv" ? "recv" : "buy")));
  };
  tabs.forEach((t) => (t.onclick = () => showTab(t.dataset.tab!)));

  let okTimer = 0;
  buyBtn.onclick = () => {
    opts.onBuy(amount);
    renderBalance(true);
    buyBtn.classList.add("ok");
    buyBtn.textContent = `✓ +$${amount} USDC`;
    clearTimeout(okTimer);
    okTimer = window.setTimeout(() => { buyBtn.classList.remove("ok"); renderAmount(); }, 1500);
  };

  // Wire the "Deposit to game" controls inside a freshly-rendered Receive view: parse dollars→cents,
  // build+sign+broadcast via onDeposit, then poll onPoll() until the credited balance lands.
  const wireDeposit = (recv: HTMLElement) => {
    if (!opts.onDeposit) return;
    const amtInput = recv.querySelector<HTMLInputElement>("#wltDepAmt");
    const depBtn = recv.querySelector<HTMLButtonElement>("#wltDepBtn");
    const status = recv.querySelector<HTMLElement>("#wltDepStatus");
    if (!amtInput || !depBtn || !status) return;
    const setStatus = (msg: string, kind?: "err" | "ok") => {
      status.textContent = msg;
      status.classList.toggle("err", kind === "err");
      status.classList.toggle("ok", kind === "ok");
    };
    depBtn.onclick = async () => {
      const dollars = parseFloat(amtInput.value);
      if (!Number.isFinite(dollars) || dollars < 0.1) { setStatus("Enter at least $0.10.", "err"); return; }
      const cents = Math.round(dollars * 100);
      depBtn.disabled = true; depBtn.classList.remove("ok");
      try {
        setStatus("Building…");
        const before = opts.balance();
        setStatus("Approve in Privy…");
        await opts.onDeposit!(cents);
        void opts.onWalletPoll?.().then((b) => renderWalletBalance(recv, b)).catch(() => {});
        setStatus("Confirming…");
        // poll for the server-confirmer credit (~3s × 10 ≈ 30s)
        let credited = false;
        if (opts.onPoll) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            let bal: number;
            try { bal = await opts.onPoll(); } catch { continue; }
            if (bal > before) { renderBalance(true); credited = true; break; }
          }
        }
        if (credited) { depBtn.classList.add("ok"); setStatus("✓ Deposited", "ok"); }
        else setStatus("Sent. Balance will update shortly.", "ok");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Deposit failed.";
        setStatus(msg, "err");
      } finally {
        depBtn.disabled = false;
      }
    };
  };

  // Re-render the Receive QR/address + the account row from the LIVE address on every open.
  // A real address only exists after login, so a build-time snapshot would never appear. Empty
  // address → no QR, no sendable address, just a "sign in first" notice (no funds into the void).
  const renderAddressUI = () => {
    const addr = opts.address();
    const recv = q<HTMLElement>('.wlt-view[data-view="recv"]');
    if (addr) {
      const qr = qrSvg(qrMatrix(addr, "M"), { dark: "#0a0820", light: "#ffffff", margin: 3 });
      // "Deposit to game" — only when a real signer is wired (privy). Sends USDC from the user's
      // wallet to the treasury; the server confirmer credits the balance, which we poll for below.
      const depBlock = opts.onDeposit
        ? `<div class="wlt-dep">
             <div class="wlt-dep-lbl">Stake to game now</div>
             <div class="wlt-dep-row">
               <label class="wlt-dep-amt"><span class="cur">$</span><input id="wltDepAmt" type="number" inputmode="decimal" value="1.00" min="0.10" step="0.10" /></label>
               <button class="wlt-dep-btn" id="wltDepBtn">Stake</button>
             </div>
             <div class="wlt-dep-status" id="wltDepStatus"></div>
           </div>`
        : "";
      recv.innerHTML =
        `<div class="wlt-qr-wrap"><div class="wlt-qr">${qr}</div></div>` +
        `<div class="wlt-net">${usdcCoin(15)} USDC · Solana network</div>` +
        `<div class="wlt-addr"><span title="${addr}">${shortAddr(addr)}</span><button class="wlt-copy" id="wltCopy">${svg(ICONS.copy, 13)}Copy</button></div>` +
        `<div class="wlt-wallet-bal"><span>Privy wallet</span><strong id="wltWalletBal">${walletBalanceText(opts.walletBalance?.())}</strong></div>` +
        depBlock +
        `<div class="wlt-note wlt-warn">This QR is your Privy wallet. Send only USDC (SPL) on Solana. Press GO to stake from this wallet into the game vault.</div>`;
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
      wireDeposit(recv);
      void refreshWalletBalance(recv);
    } else {
      recv.innerHTML = `<div class="wlt-note wlt-warn">No deposit address yet. Sign in with your wallet to get your personal deposit address. Do not send any funds until it appears here.</div>`;
    }
    const acct = q<HTMLElement>("#wltAcct");
    if (addr && opts.onLogout) {
      acct.innerHTML =
        `<div class="wlt-acct"><div class="wlt-acct-info"><span class="wlt-acct-lbl">Account</span>` +
        `<span class="wlt-acct-addr" title="${addr}">${shortWallet(addr)}</span></div>` +
        `<button class="wlt-logout" id="wltLogout">Log out</button></div>`;
      const logoutBtn = acct.querySelector<HTMLButtonElement>("#wltLogout");
      if (logoutBtn) logoutBtn.onclick = () => { setOpen(false); opts.onLogout?.(); };
    } else {
      acct.innerHTML = "";
    }
  };

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    if (open) { renderBalance(); renderAddressUI(); showTab("buy"); }
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
    setBalance() { renderBalance(); },
    setBusy(b) { busy = b; if (b) setOpen(false); },
  };
}
