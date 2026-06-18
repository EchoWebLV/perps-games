export interface Controls {
  dir(): 1 | -1;
  stake(): number;
  gas(): boolean;
  brake(): boolean;
  steer(): number; // -1 left, 0, 1 right
  setLive(live: boolean, label: string, warn?: boolean): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

const seg = "background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 9px";
const lab = "display:block;margin-bottom:6px";

export function createControls(ctrlMount: HTMLElement, goMount: HTMLElement, pedalMount: HTMLElement): Controls {
  ctrlMount.innerHTML = `
    <div style="${seg}"><span class="lbl" style="${lab}">your call</span>
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
    <div style="display:flex;gap:7px;margin-top:7px">
      <div id="brake" class="pedal brk">▼</div>
      <div id="gas" class="pedal gas">▲ Gas</div>
    </div>
    <div class="lbl" style="text-align:center;margin-top:5px">hold gas to rev · ↑↓</div>`;
  goMount.innerHTML = `<button id="go" class="cta">Launch</button>`;

  const q = (s: string) => (ctrlMount.querySelector(s) || goMount.querySelector(s) || pedalMount.querySelector(s)) as HTMLElement;
  let d: 1 | -1 = 1, stake = 1, live = false;
  let gasOn = false, brakeOn = false, steerL = false, steerR = false;
  let launchCb = () => {}, cashCb = () => {};
  const long = q("#long"), short = q("#short"), sval = q("#sval"), go = q("#go"), gasBtn = q("#gas"), brakeBtn = q("#brake");

  const setDir = (nd: 1 | -1) => {
    if (live) return;
    d = nd;
    long.classList.toggle("on", nd === 1);
    short.classList.toggle("on", nd === -1);
  };
  long.onclick = () => setDir(1);
  short.onclick = () => setDir(-1);
  q("#sup").onclick = () => { if (!live) { stake = Math.min(50, stake + 1); sval.textContent = "$" + stake.toFixed(2); } };
  q("#sdn").onclick = () => { if (!live) { stake = Math.max(1, stake - 1); sval.textContent = "$" + stake.toFixed(2); } };
  go.onclick = () => (live ? cashCb() : launchCb());

  // hold-to-accelerate pedals (pointer + keyboard), with a pressed visual
  const press = (el: HTMLElement, on: boolean) => el.classList.toggle("held", on);
  const hold = (el: HTMLElement, set: (v: boolean) => void) => {
    el.addEventListener("pointerdown", (e) => { set(true); press(el, true); el.setPointerCapture(e.pointerId); e.preventDefault(); });
    el.addEventListener("pointerup", () => { set(false); press(el, false); });
    el.addEventListener("pointercancel", () => { set(false); press(el, false); });
    el.addEventListener("pointerleave", () => { set(false); press(el, false); });
  };
  hold(gasBtn, (v) => (gasOn = v));
  hold(brakeBtn, (v) => (brakeOn = v));
  addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") { gasOn = true; press(gasBtn, true); e.preventDefault(); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { brakeOn = true; press(brakeBtn, true); e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { steerL = true; e.preventDefault(); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { steerR = true; e.preventDefault(); }
    else if (k === " " || k === "Enter") { go.click(); e.preventDefault(); }
  });
  addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") { gasOn = false; press(gasBtn, false); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { brakeOn = false; press(brakeBtn, false); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") steerL = false;
    else if (k === "ArrowRight" || k === "d" || k === "D") steerR = false;
  });

  return {
    dir: () => d,
    stake: () => stake,
    gas: () => gasOn,
    brake: () => brakeOn,
    steer: () => (steerR ? 1 : 0) - (steerL ? 1 : 0),
    setLive(l, label, warn) {
      live = l;
      go.textContent = label;
      go.classList.toggle("live", l && !warn);
      go.classList.toggle("warn", !!(l && warn));
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
