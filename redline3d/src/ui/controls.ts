import { usd } from "../core/money";

export interface Controls {
  dir(): 1 | -1;
  /** set the LONG/SHORT call externally (e.g. the Clown Car's lane-bet ability) — works live too */
  setDir(d: 1 | -1): void;
  /** Clown Car: keep the call box visible during a live round so it reads out the live direction */
  setLaneMode(on: boolean): void;
  stake(): number;
  gas(): boolean;
  brake(): boolean;
  steer(): number; // -1 left, 0, 1 right
  setLive(live: boolean, label: string, warn?: boolean): void;
  /** drain the live button's liquidation gauge: 1 = full margin, 0 = at liquidation */
  setBuffer(buf: number): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

const seg = "background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 9px";
const lab = "display:block;margin-bottom:6px";

export function createControls(ctrlMount: HTMLElement, goMount: HTMLElement, pedalMount: HTMLElement): Controls {
  ctrlMount.innerHTML = `
    <div id="callbox" style="${seg};transition:opacity .5s ease"><span class="lbl" style="${lab}">your call</span>
      <div style="display:flex;gap:7px">
        <div id="long" class="seg long on">▲ Long</div>
        <div id="short" class="seg short">▼ Short</div>
      </div></div>
    <div style="${seg}"><span class="lbl" style="${lab}">stake</span>
      <div style="display:flex;align-items:center;gap:7px">
        <div id="sdn" class="step">−</div>
        <div id="sval" class="num" style="flex:1;text-align:center;font-size:16px">$1.00</div>
        <div id="sup" class="step">+</div>
      </div></div>`;
  pedalMount.innerHTML = `
    <div class="lbl" style="text-align:center;margin-top:8px;line-height:1.45;opacity:.8">hold road to drive<br>drag · pull back = brake</div>`;
  goMount.innerHTML = `<button id="go" class="cta"><span id="gofill"></span><span id="golabel">GO!</span></button>`;

  const q = (s: string) => (ctrlMount.querySelector(s) || goMount.querySelector(s) || pedalMount.querySelector(s)) as HTMLElement;
  let d: 1 | -1 = 1, stake = 100, live = false; // stake in cents → $1.00 default
  let gasOn = false, brakeOn = false, steerL = false, steerR = false;
  let launchCb = () => {}, cashCb = () => {};
  const long = q("#long"), short = q("#short"), sval = q("#sval"), go = q("#go"),
    golabel = q("#golabel"), gofill = q("#gofill"), callbox = q("#callbox");

  let laneMode = false;
  // apply a direction to the UI (used live by the lane-bet); plain clicks stay idle-only
  const applyDir = (nd: 1 | -1) => {
    d = nd;
    long.classList.toggle("on", nd === 1);
    short.classList.toggle("on", nd === -1);
  };
  const setDir = (nd: 1 | -1) => { if (live) return; applyDir(nd); };
  long.onclick = () => setDir(1);
  short.onclick = () => setDir(-1);
  // the call box hides during a live round — except in lane mode, where it stays
  // visible (but non-interactive) as a live LONG/SHORT readout the lane drives
  const refreshCall = () => {
    callbox.style.opacity = !live || laneMode ? "1" : "0";
    callbox.style.pointerEvents = live ? "none" : "auto";
  };
  q("#sup").onclick = () => { if (!live) { stake = Math.min(5000, stake + 25); sval.textContent = usd(stake); } }; // +$0.25 → $50 cap
  q("#sdn").onclick = () => { if (!live) { stake = Math.max(25, stake - 25); sval.textContent = usd(stake); } };   // −$0.25 → $0.25 floor
  go.onclick = () => (live ? cashCb() : launchCb());

  // keyboard driving (desktop): W/↑ gas, S/↓ brake, A/D or ←/→ steer, space/enter = go.
  // Touch driving (hold-anywhere) lives on the canvas in main.ts.
  addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") { gasOn = true; e.preventDefault(); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { brakeOn = true; e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { steerL = true; e.preventDefault(); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { steerR = true; e.preventDefault(); }
    else if (k === " " || k === "Enter") { go.click(); e.preventDefault(); }
  });
  addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") gasOn = false;
    else if (k === "ArrowDown" || k === "s" || k === "S") brakeOn = false;
    else if (k === "ArrowLeft" || k === "a" || k === "A") steerL = false;
    else if (k === "ArrowRight" || k === "d" || k === "D") steerR = false;
  });

  return {
    dir: () => d,
    setDir: applyDir,
    setLaneMode(on: boolean) { laneMode = on; refreshCall(); },
    stake: () => stake,
    gas: () => gasOn,
    brake: () => brakeOn,
    steer: () => (steerR ? 1 : 0) - (steerL ? 1 : 0),
    setLive(l, label, warn) {
      live = l;
      golabel.textContent = label;
      // the LIVE button becomes the liquidation gauge; idle is the green GO!
      go.classList.toggle("gauge", l);
      go.classList.toggle("warn", !!(l && warn)); // red glow when losing / near liq
      if (!l) gofill.style.setProperty("--b", "100%"); // reset the fill for next round
      // long/short fades out for the live round (kept as a live readout in lane mode)
      refreshCall();
    },
    setBuffer(buf) {
      const b = Math.max(0, Math.min(1, buf));
      gofill.style.setProperty("--b", (b * 100).toFixed(1) + "%");
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
