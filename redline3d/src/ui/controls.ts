export interface Controls {
  dir(): 1 | -1;
  stake(): number;
  setLive(live: boolean, label: string, warn?: boolean): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

const seg = "background:rgba(8,6,20,.62);border:1px solid rgba(120,140,210,.22);border-radius:13px;padding:7px 9px";
const lab = "font-size:9px;letter-spacing:.12em;color:#6a76a0;font-weight:800;display:block;margin-bottom:5px";

export function createControls(ctrlMount: HTMLElement, goMount: HTMLElement): Controls {
  ctrlMount.innerHTML = `
    <div style="${seg}"><span style="${lab}">YOUR CALL</span>
      <div style="display:flex;gap:6px">
        <div id="long" style="flex:1;text-align:center;padding:7px 0;border:1px solid #2ee6a6;border-radius:9px;font-weight:800;font-size:13px;color:#2ee6a6;background:rgba(46,230,166,.18)">▲ LONG</div>
        <div id="short" style="flex:1;text-align:center;padding:7px 0;border:1px solid rgba(120,140,210,.3);border-radius:9px;font-weight:800;font-size:13px;color:#9aa6c8">▼ SHORT</div>
      </div></div>
    <div style="${seg}"><span style="${lab}">STAKE</span>
      <div style="display:flex;align-items:center;gap:6px">
        <div id="sdn" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-size:17px;font-weight:800;color:#eaf0ff">−</div>
        <div id="sval" style="flex:1;text-align:center;font-weight:900;font-size:15px">$1.00</div>
        <div id="sup" style="width:30px;height:30px;border:1px solid rgba(120,140,210,.3);border-radius:9px;text-align:center;line-height:30px;font-size:17px;font-weight:800;color:#eaf0ff">+</div>
      </div></div>`;
  goMount.innerHTML = `
    <button id="go" style="width:100%;border:none;border-radius:15px;padding:15px;font-size:18px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#06121a;cursor:pointer;background:linear-gradient(180deg,#43f0b0,#13c98a);box-shadow:0 8px 26px rgba(46,230,166,.36)">🚀 LAUNCH</button>`;

  const q = (s: string) => (ctrlMount.querySelector(s) || goMount.querySelector(s)) as HTMLElement;
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
  q("#sup").onclick = () => { if (!live) { stake = Math.min(50, stake + 1); sval.textContent = "$" + stake.toFixed(2); } };
  q("#sdn").onclick = () => { if (!live) { stake = Math.max(1, stake - 1); sval.textContent = "$" + stake.toFixed(2); } };
  go.onclick = () => (live ? cashCb() : launchCb());

  return {
    dir: () => d,
    stake: () => stake,
    setLive(l, label, warn) {
      live = l;
      go.textContent = label;
      go.style.background = !l
        ? "linear-gradient(180deg,#43f0b0,#13c98a)"
        : warn
          ? "linear-gradient(180deg,#ff9aa6,#ff5067)"
          : "linear-gradient(180deg,#ffe08a,#ffc23d)";
      go.style.color = l && warn ? "#fff" : "#06121a";
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
