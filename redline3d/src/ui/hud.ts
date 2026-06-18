export interface Hud {
  root: HTMLElement;
  tachMount: HTMLElement;
  ctrlMount: HTMLElement;
  goMount: HTMLElement;
  pedalMount: HTMLElement;
  setPrice(px: number, live: boolean): void;
  setBalance(b: number): void;
  setMultiplier(equity: number, phase: "idle" | "live" | "settled" | "liquidated"): void;
  setBuffer(buf: number, visible: boolean): void;
  setStatus(text: string): void;
}

const chip = "background:rgba(8,6,20,.5);backdrop-filter:blur(4px);border:1px solid rgba(120,140,210,.22);border-radius:10px;padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8";

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));left:14px;${chip}">
      balance<b id="bal" style="display:block;color:#eaf0ff;font-size:15px">$100.00</b></div>
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));right:14px;text-align:right;${chip}">
      SOL<b id="solpx" style="display:block;color:#eaf0ff;font-size:15px">$—</b><span id="feed" style="color:#ffd166">connecting…</span></div>

    <div style="position:absolute;left:0;right:0;top:19%;text-align:center;pointer-events:none">
      <div id="multi" style="font-family:ui-monospace,monospace;font-weight:800;font-size:clamp(44px,15vw,64px);line-height:1;color:#2ee6a6;text-shadow:0 0 26px rgba(46,230,166,.55)">×1.00</div>
      <div id="buf" style="width:188px;max-width:60vw;height:8px;margin:10px auto 0;border-radius:6px;background:rgba(8,6,20,.62);border:1px solid rgba(120,140,210,.28);overflow:hidden;opacity:0;transition:opacity .2s">
        <div id="buffill" style="height:100%;width:100%;background:#2ee6a6;transition:width .08s linear,background .25s"></div></div>
    </div>

    <div class="pe" id="dock" style="position:absolute;left:50%;transform:translateX(-50%);bottom:max(28px,env(safe-area-inset-bottom));width:min(448px,96%);
      display:flex;flex-direction:column;gap:8px">
      <div id="status" style="text-align:center;font-size:10.5px;color:#cdd6f5;min-height:14px;text-shadow:0 1px 8px rgba(0,0,0,.7)"></div>
      <div style="display:flex;gap:10px;align-items:flex-end">
        <div style="flex:none;width:140px;display:flex;flex-direction:column">
          <div id="tachMount"></div>
          <div id="pedalMount"></div>
        </div>
        <div id="ctrlMount" style="flex:1;display:flex;flex-direction:column;gap:7px;justify-content:center"></div>
      </div>
      <div id="goMount"></div>
    </div>`;

  const q = (s: string) => parent.querySelector(s) as HTMLElement;
  const bal = q("#bal"), px = q("#solpx"), feed = q("#feed"), multi = q("#multi"),
    buf = q("#buf"), buffill = q("#buffill"), status = q("#status");

  return {
    root: parent,
    tachMount: q("#tachMount"),
    ctrlMount: q("#ctrlMount"),
    goMount: q("#goMount"),
    pedalMount: q("#pedalMount"),
    setPrice(p, live) { px.textContent = "$" + (p ? p.toFixed(2) : "—"); feed.textContent = live ? "live" : "sim"; feed.style.color = live ? "#2ee6a6" : "#ffd166"; },
    setBalance(b) { bal.textContent = "$" + b.toFixed(2); },
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
