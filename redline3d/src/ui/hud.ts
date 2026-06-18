export interface Hud {
  root: HTMLElement;
  setPrice(px: number, live: boolean): void;
  setBalance(b: number): void;
  setMultiplier(equity: number, phase: "idle" | "live" | "settled" | "liquidated"): void;
  setBuffer(buf: number, visible: boolean): void;
  setStatus(text: string): void;
}

export function createHud(parent: HTMLElement): Hud {
  parent.innerHTML = `
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));left:14px;
      background:rgba(8,6,20,.5);border:1px solid rgba(120,140,210,.22);border-radius:10px;padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8">
      balance<b id="bal" style="display:block;color:#eaf0ff;font-size:15px">$100.00</b></div>
    <div class="pe" style="position:absolute;top:max(10px,env(safe-area-inset-top));right:14px;text-align:right;
      background:rgba(8,6,20,.5);border:1px solid rgba(120,140,210,.22);border-radius:10px;padding:5px 9px;font-size:10px;font-weight:700;color:#9aa6c8">
      SOL<b id="solpx" style="display:block;color:#eaf0ff;font-size:15px">$—</b><span id="feed" style="color:#ffd166">connecting…</span></div>
    <div style="position:absolute;left:0;right:0;top:34%;text-align:center">
      <div id="multi" style="font-family:ui-monospace,monospace;font-weight:800;font-size:58px;color:#2ee6a6">×1.00</div>
      <div id="buf" style="width:188px;max-width:62vw;height:8px;margin:11px auto 0;border-radius:6px;background:rgba(8,6,20,.62);border:1px solid rgba(120,140,210,.28);overflow:hidden;opacity:0">
        <div id="buffill" style="height:100%;width:100%;background:#2ee6a6"></div></div>
    </div>
    <div id="status" style="position:absolute;left:0;right:0;bottom:178px;text-align:center;font-size:11px;color:#cdd6f5;padding:0 14px"></div>`;
  const q = (s: string) => parent.querySelector(s) as HTMLElement;
  const bal = q("#bal"), px = q("#solpx"), feed = q("#feed"), multi = q("#multi"),
    buf = q("#buf"), buffill = q("#buffill"), status = q("#status");
  return {
    root: parent,
    setPrice(p, live) { px.textContent = "$" + (p ? p.toFixed(2) : "—"); feed.textContent = live ? "live" : "sim"; feed.style.color = live ? "#2ee6a6" : "#ffd166"; },
    setBalance(b) { bal.textContent = "$" + b.toFixed(2); },
    setMultiplier(equity, phase) {
      multi.textContent = "×" + equity.toFixed(2);
      multi.style.color = phase === "liquidated" ? "#ff4d6d" : equity >= 1 ? "#2ee6a6" : "#ff5067";
    },
    setBuffer(b, visible) {
      buf.style.opacity = visible ? "1" : "0";
      buffill.style.width = (b * 100).toFixed(1) + "%";
      buffill.style.background = b > 0.5 ? "#2ee6a6" : b > 0.25 ? "#ffd166" : "#ff4d6d";
    },
    setStatus(t) { status.textContent = t; },
  };
}
