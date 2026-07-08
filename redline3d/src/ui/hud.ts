import { sol3 } from "../core/money";

export interface Hud {
  root: HTMLElement;
  tachMount: HTMLElement;
  ctrlMount: HTMLElement;
  goMount: HTMLElement;
  pedalMount: HTMLElement;
  miniCanvas: HTMLCanvasElement;
  setPrice(px: number, live: boolean): void;
  setBalance(b: number): void;
  onAsset(cb: (asset: string) => void): void;
  setActiveAsset(asset: string): void;
  setMultiplier(equity: number, phase: "idle" | "live" | "settled" | "liquidated"): void;
  setTimer(secLeft: number, live: boolean): void;
  setStatus(text: string): void;
  /** cruise chrome: hide the whole trading cluster (price chip, timer, ×N, the graph) —
   *  cruising the strip keeps ONLY the balance chip (+ the hamburger, owned elsewhere) */
  setMinimal(on: boolean): void;
  /** guest practice mode: the money chip reads "practice" instead of a SOL balance
   *  (tapping it is the sign-in upsell — wired via onWallet) */
  setTryMode(on: boolean): void;
  /** tapping the balance chip opens the wallet page */
  onWallet(cb: () => void): void;
}

const top = "top:max(10px,env(safe-area-inset-top))";

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div id="balchip" class="pe panel chip" style="position:absolute;${top};left:14px;cursor:pointer" aria-label="Open wallet">
      <span class="lbl">balance</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span id="bal" class="num">0.000 SOL</span>
        <span id="baladd" style="display:grid;place-items:center;width:17px;height:17px;border-radius:50%;font-size:14px;font-weight:700;line-height:0;color:#04101a;background:linear-gradient(180deg,#5fe3ff,#2775ca);box-shadow:0 0 9px rgba(39,231,255,.55)">+</span>
      </span></div>

    <div id="pxchip" class="pe panel chip" style="position:absolute;${top};right:14px;text-align:right">
      <span class="lbl"><span id="asset">SOL</span> · <span id="feed" style="color:var(--amb)">connecting</span></span>
      <span id="solpx" class="num">$—</span></div>

    <div id="tmrchip" class="panel chip" style="position:absolute;top:max(12px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);padding:5px 13px">
      <span id="timer" class="num" style="font-size:15px;letter-spacing:.1em;color:var(--mut)">1:00</span></div>

    <div id="minipanel" class="panel" style="position:absolute;left:50%;transform:translateX(-50%);top:64px;width:min(420px,92%);height:70px;overflow:hidden;padding:0">
      <canvas id="mini" style="width:100%;height:100%;display:block"></canvas>
      <div class="pe" style="position:absolute;top:6px;left:7px;display:flex;gap:5px">
        <div class="atab" data-asset="BTC">BTC</div>
        <div class="atab" data-asset="ETH">ETH</div>
        <div class="atab" data-asset="SOL">SOL</div>
      </div></div>

    <div id="ctr" style="position:absolute;left:0;right:0;top:19%;text-align:center;pointer-events:none">
      <div id="multi" class="num" style="font-size:clamp(46px,15vw,66px);line-height:1;letter-spacing:.02em;-webkit-text-stroke:2.5px #000;text-stroke:2.5px #000;paint-order:stroke;color:var(--grn);text-shadow:0 0 26px rgba(46,230,166,.5)">×1.00</div>
    </div>

    <div id="dock" class="pe" style="position:absolute;left:50%;transform:translateX(-50%);bottom:max(28px,env(safe-area-inset-bottom));width:min(448px,96%);display:flex;flex-direction:column;gap:9px">
      <div id="status" class="lbl" style="text-align:center;letter-spacing:.08em;color:#aeb8dc;min-height:13px;text-shadow:0 1px 8px rgba(0,0,0,.8)"></div>
      <div style="display:flex;gap:10px;align-items:flex-end">
        <div id="driveCol" style="flex:1;display:flex;flex-direction:column">
          <div id="tachMount"></div>
          <div id="pedalMount"></div>
        </div>
        <div id="ctrlMount" style="flex:1;display:flex;flex-direction:column;gap:8px;justify-content:center"></div>
      </div>
      <div id="goMount"></div>
    </div>`;

  const q = (s: string) => parent.querySelector(s) as HTMLElement;
  const bal = q("#bal"), px = q("#solpx"), feed = q("#feed"), multi = q("#multi"),
    status = q("#status"), assetEl = q("#asset"), timer = q("#timer"), balchip = q("#balchip");
  const tabs = Array.from(parent.querySelectorAll<HTMLElement>(".atab"));

  // Last-written values for the setters the rAF loop hits at 60fps (price/multiplier/timer).
  // Most frames the strings are unchanged (idle price, 1s timer granularity) — skipping the
  // identical DOM/style writes keeps text/CSSOM churn out of the WebView's frame budget.
  let lastPx = "", lastFeed = "", lastMulti = "", lastMultiCol = "", lastTimer = "", lastTimerCol = "";

  return {
    root: parent,
    tachMount: q("#tachMount"),
    ctrlMount: q("#ctrlMount"),
    goMount: q("#goMount"),
    pedalMount: q("#pedalMount"),
    miniCanvas: q("#mini") as HTMLCanvasElement,
    setPrice(p, live) {
      const t = "$" + (p ? p.toFixed(2) : "—");
      if (t !== lastPx) { lastPx = t; px.textContent = t; }
      const f = live ? "live" : "sim";
      if (f !== lastFeed) { lastFeed = f; feed.textContent = f; feed.style.color = live ? "var(--grn)" : "var(--amb)"; }
    },
    setBalance(b) { bal.textContent = sol3(b); }, // centi-SOL units → "0.917 SOL"
    onAsset(cb) { for (const t of tabs) t.onclick = () => cb(t.dataset.asset!); },
    setActiveAsset(a) {
      assetEl.textContent = a;
      for (const t of tabs) {
        const on = t.dataset.asset === a;
        t.style.borderColor = on ? "var(--cyan)" : "var(--line2)";
        t.style.color = on ? "var(--cyan)" : "var(--mut)";
        t.style.background = on ? "rgba(39,231,255,.14)" : "rgba(10,8,22,.55)";
      }
    },
    setMultiplier(equity, phase) {
      const t = "×" + equity.toFixed(2);
      if (t !== lastMulti) { lastMulti = t; multi.textContent = t; }
      const col = phase === "liquidated" ? "#ff4d6d" : phase === "settled" ? (equity >= 1 ? "#2ee6a6" : "#ffd166") : equity >= 1 ? "#2ee6a6" : "#ff5067";
      if (col !== lastMultiCol) { lastMultiCol = col; multi.style.color = col; multi.style.textShadow = "0 0 26px " + col + "8c"; }
    },
    setTimer(secLeft, live) {
      const s = Math.max(0, Math.ceil(secLeft));
      const t = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      if (t !== lastTimer) { lastTimer = t; timer.textContent = t; }
      // dim when idle; colour-coded by urgency once a round is live
      const col = !live ? "var(--mut)" : secLeft > 20 ? "#aef0d0" : secLeft > 8 ? "#ffd166" : "#ff5067";
      if (col !== lastTimerCol) { lastTimerCol = col; timer.style.color = col; }
    },
    setStatus(t) { status.textContent = t; },
    setTryMode(on) {
      const label = balchip.querySelector(".lbl") as HTMLElement | null;
      const add = balchip.querySelector("#baladd") as HTMLElement | null;
      if (label) label.textContent = on ? "guest" : "balance";
      if (add) add.style.display = on ? "none" : "grid";
      if (on) bal.textContent = "practice";
    },
    setMinimal(on) {
      const d = on ? "none" : "";
      q("#pxchip").style.display = d;
      q("#tmrchip").style.display = d;
      q("#ctr").style.display = d;
      q("#minipanel").style.display = d;
      q("#dock").style.display = on ? "none" : "flex";
    },
    onWallet(cb) { balchip.onclick = cb; },
  };
}
