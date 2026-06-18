export interface Controls {
  dir(): 1 | -1;
  stake(): number;
  setLive(live: boolean, label: string): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

export function createControls(parent: HTMLElement): Controls {
  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;left:14px;right:14px;bottom:14px;display:flex;flex-direction:column;gap:8px";
  wrap.innerHTML = `
    <div style="display:flex;gap:8px">
      <div id="long" style="flex:1;text-align:center;padding:8px;border:1px solid #2ee6a6;border-radius:10px;color:#2ee6a6;font-weight:800;background:rgba(46,230,166,.18)">▲ LONG</div>
      <div id="short" style="flex:1;text-align:center;padding:8px;border:1px solid rgba(120,140,210,.3);border-radius:10px;color:#9aa6c8;font-weight:800">▼ SHORT</div>
      <div style="display:flex;align-items:center;gap:6px">
        <div id="sdn" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-weight:800">−</div>
        <div id="sval" style="min-width:48px;text-align:center;font-weight:900">$1</div>
        <div id="sup" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-weight:800">+</div>
      </div>
    </div>
    <button id="go" style="width:100%;border:none;border-radius:14px;padding:15px;font-size:17px;font-weight:900;text-transform:uppercase;color:#06121a;background:linear-gradient(180deg,#43f0b0,#13c98a)">🚀 LAUNCH</button>`;
  parent.appendChild(wrap);
  const q = (s: string) => wrap.querySelector(s) as HTMLElement;
  let d: 1 | -1 = 1, stake = 1, live = false;
  let launchCb = () => {}, cashCb = () => {};
  const long = q("#long"), short = q("#short"), sval = q("#sval"), go = q("#go");
  const setDir = (nd: 1 | -1) => {
    if (live) return;
    d = nd;
    long.style.borderColor = nd === 1 ? "#2ee6a6" : "rgba(120,140,210,.3)";
    long.style.color = nd === 1 ? "#2ee6a6" : "#9aa6c8";
    long.style.background = nd === 1 ? "rgba(46,230,166,.18)" : "transparent";
    short.style.borderColor = nd === -1 ? "#ff4d6d" : "rgba(120,140,210,.3)";
    short.style.color = nd === -1 ? "#ff4d6d" : "#9aa6c8";
    short.style.background = nd === -1 ? "rgba(255,77,109,.18)" : "transparent";
  };
  long.onclick = () => setDir(1);
  short.onclick = () => setDir(-1);
  q("#sup").onclick = () => { if (!live) { stake = Math.min(50, stake + 1); sval.textContent = "$" + stake; } };
  q("#sdn").onclick = () => { if (!live) { stake = Math.max(1, stake - 1); sval.textContent = "$" + stake; } };
  go.onclick = () => (live ? cashCb() : launchCb());
  return {
    dir: () => d,
    stake: () => stake,
    setLive(l, label) {
      live = l;
      go.textContent = label;
      go.style.background = l ? "linear-gradient(180deg,#ffe08a,#ffc23d)" : "linear-gradient(180deg,#43f0b0,#13c98a)";
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
