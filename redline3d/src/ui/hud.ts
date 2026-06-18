export interface Hud {
  root: HTMLElement;
  tachMount: HTMLElement;
  ctrlMount: HTMLElement;
  goMount: HTMLElement;
  pedalMount: HTMLElement;
  miniCanvas: HTMLCanvasElement;
  setPrice(px: number, live: boolean): void;
  setBalance(b: number): void;
  setCoins(n: number): void;
  onAsset(cb: (asset: string) => void): void;
  setActiveAsset(asset: string): void;
  setMultiplier(equity: number, phase: "idle" | "live" | "settled" | "liquidated"): void;
  setBuffer(buf: number, visible: boolean): void;
  setStatus(text: string): void;
}

const top = "top:max(10px,env(safe-area-inset-top))";

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div class="pe panel chip" style="position:absolute;${top};left:14px">
      <span class="lbl">balance</span><span id="bal" class="num">$100.00</span></div>

    <div class="pe panel chip" style="position:absolute;${top};right:14px;text-align:right">
      <span class="lbl"><span id="asset">SOL</span> · <span id="feed" style="color:var(--amb)">connecting</span></span>
      <span id="solpx" class="num">$—</span></div>

    <div class="pe panel chip" style="position:absolute;top:max(12px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);padding:5px 12px;display:flex;align-items:center;gap:6px">
      <span style="color:var(--amb);font-size:13px;line-height:1">◆</span><span id="coins" class="num" style="font-size:14px;color:var(--amb)">0</span></div>

    <div class="panel" style="position:absolute;left:50%;transform:translateX(-50%);top:64px;width:min(420px,92%);height:70px;overflow:hidden;padding:0">
      <canvas id="mini" style="width:100%;height:100%;display:block"></canvas>
      <div class="pe" style="position:absolute;top:6px;left:7px;display:flex;gap:5px">
        <div class="atab" data-asset="BTC">BTC</div>
        <div class="atab" data-asset="ETH">ETH</div>
        <div class="atab" data-asset="SOL">SOL</div>
      </div></div>

    <div style="position:absolute;left:0;right:0;top:20%;text-align:center;pointer-events:none">
      <div id="multi" class="num" style="font-size:clamp(46px,15vw,66px);line-height:1;letter-spacing:.02em;color:var(--grn);text-shadow:0 0 26px rgba(46,230,166,.5)">×1.00</div>
      <div id="buf" style="width:188px;max-width:60vw;height:7px;margin:11px auto 0;border-radius:5px;background:rgba(8,6,20,.7);border:1px solid var(--line2);overflow:hidden;opacity:0;transition:opacity .2s">
        <div id="buffill" style="height:100%;width:100%;background:var(--grn);transition:width .08s linear,background .25s"></div></div>
    </div>

    <div class="pe" style="position:absolute;left:50%;transform:translateX(-50%);bottom:max(28px,env(safe-area-inset-bottom));width:min(448px,96%);display:flex;flex-direction:column;gap:9px">
      <div id="status" class="lbl" style="text-align:center;letter-spacing:.08em;color:#aeb8dc;min-height:13px;text-shadow:0 1px 8px rgba(0,0,0,.8)"></div>
      <div style="display:flex;gap:10px;align-items:flex-end">
        <div style="flex:none;width:142px;display:flex;flex-direction:column">
          <div id="tachMount"></div>
          <div id="pedalMount"></div>
        </div>
        <div id="ctrlMount" style="flex:1;display:flex;flex-direction:column;gap:8px;justify-content:center"></div>
      </div>
      <div id="goMount"></div>
    </div>`;

  const q = (s: string) => parent.querySelector(s) as HTMLElement;
  const bal = q("#bal"), px = q("#solpx"), feed = q("#feed"), multi = q("#multi"),
    buf = q("#buf"), buffill = q("#buffill"), status = q("#status"), coins = q("#coins"), assetEl = q("#asset");
  const tabs = Array.from(parent.querySelectorAll<HTMLElement>(".atab"));

  return {
    root: parent,
    tachMount: q("#tachMount"),
    ctrlMount: q("#ctrlMount"),
    goMount: q("#goMount"),
    pedalMount: q("#pedalMount"),
    miniCanvas: q("#mini") as HTMLCanvasElement,
    setPrice(p, live) { px.textContent = "$" + (p ? p.toFixed(2) : "—"); feed.textContent = live ? "live" : "sim"; feed.style.color = live ? "var(--grn)" : "var(--amb)"; },
    setBalance(b) { bal.textContent = "$" + b.toFixed(2); },
    setCoins(n) { coins.textContent = String(n); },
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
      multi.textContent = "×" + equity.toFixed(2);
      const col = phase === "liquidated" ? "#ff4d6d" : phase === "settled" ? (equity >= 1 ? "#2ee6a6" : "#ffd166") : equity >= 1 ? "#2ee6a6" : "#ff5067";
      multi.style.color = col;
      multi.style.textShadow = "0 0 26px " + col + "8c";
    },
    setBuffer(b, visible) {
      buf.style.opacity = visible ? "1" : "0";
      buffill.style.width = (b * 100).toFixed(1) + "%";
      buffill.style.background = b > 0.5 ? "#2ee6a6" : b > 0.25 ? "#ffd166" : "#ff4d6d";
    },
    setStatus(t) { status.textContent = t; },
  };
}
