import { tToLev, niceLev } from "../core/leverage";
import { CONFIG } from "../core/config";

export interface Tach {
  lev(): number;
  onChange(cb: (lev: number) => void): void;
}

const CX = 160, CY = 170, R = 140;
const { RMIN, RMAX, REDLINE } = CONFIG;

function lf(l: number): number {
  return Math.log(l / RMIN) / Math.log(RMAX / RMIN);
}
function pt(f: number, rad: number): [number, number] {
  const a = Math.PI * (1 - f);
  return [CX + rad * Math.cos(a), CY - rad * Math.sin(a)];
}
function arc(f0: number, f1: number, rad: number, n: number): string {
  let d = "";
  for (let i = 0; i <= n; i++) {
    const f = f0 + (f1 - f0) * (i / n);
    const p = pt(f, rad);
    d += (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1);
  }
  return d;
}
function gcol(gfrac: number): string {
  return gfrac >= lf(REDLINE) ? "#ff4d6d" : gfrac >= 0.4 ? "#ffd166" : "#2ee6a6";
}

/** Curved redline tachometer used to set leverage. Drag across the arc. */
export function createTach(mount: HTMLElement): Tach {
  mount.style.touchAction = "none";
  mount.innerHTML = `
    <svg viewBox="0 0 320 184" style="width:100%;display:block">
      <path d="${arc(0, 1, R, 56)}" fill="none" stroke="#1a2036" stroke-width="16" stroke-linecap="round"/>
      <path d="${arc(lf(REDLINE), 1, R, 22)}" fill="none" stroke="rgba(255,77,109,.4)" stroke-width="16"/>
      <path id="tfill" fill="none" stroke="#2ee6a6" stroke-width="16" stroke-linecap="round"/>
      <line id="tneedle" x1="${CX}" y1="${CY}" x2="${CX}" y2="40" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
      <circle id="thub" cx="${CX}" cy="${CY}" r="11" fill="#0a0820" stroke="#2ee6a6" stroke-width="3"/>
      <text id="tval" x="${CX}" y="150" text-anchor="middle" font-family="ui-monospace,monospace" font-size="46" font-weight="900" fill="#2ee6a6">50×</text>
    </svg>
    <div style="text-align:center;font-size:9px;letter-spacing:.12em;color:#6a76a0;font-weight:800;margin-top:-2px">LEVERAGE · drag</div>`;
  const svg = mount.querySelector("svg") as SVGSVGElement;
  const fill = mount.querySelector("#tfill") as SVGPathElement;
  const needle = mount.querySelector("#tneedle") as SVGLineElement;
  const hub = mount.querySelector("#thub") as SVGCircleElement;
  const val = mount.querySelector("#tval") as SVGTextElement;

  let gfrac = 0.34;
  let lev = niceLev(tToLev(gfrac * 100));
  let cb: (lev: number) => void = () => {};

  function render() {
    const c = gcol(gfrac);
    fill.setAttribute("d", arc(0, Math.max(0.001, gfrac), R, Math.max(2, Math.round(gfrac * 56))));
    fill.setAttribute("stroke", c);
    const tip = pt(gfrac, R - 34);
    needle.setAttribute("x2", tip[0].toFixed(1));
    needle.setAttribute("y2", tip[1].toFixed(1));
    needle.setAttribute("stroke", c);
    hub.setAttribute("stroke", c);
    val.textContent = lev + "×";
    val.setAttribute("fill", c);
  }
  function setFrac(f: number) {
    gfrac = Math.max(0, Math.min(1, f));
    const newLev = niceLev(tToLev(gfrac * 100));
    render();
    if (newLev !== lev) {
      lev = newLev;
      render();
      cb(lev);
    }
  }
  function fromPoint(clientX: number, clientY: number) {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const vx = ((clientX - r.left) / r.width) * 320;
    const vy = ((clientY - r.top) / r.height) * 184;
    let ang = Math.atan2(CY - vy, vx - CX);
    if (ang < 0) ang = vx < CX ? Math.PI : 0;
    setFrac(1 - ang / Math.PI);
  }

  let drag = false;
  svg.addEventListener("pointerdown", (e) => { drag = true; fromPoint(e.clientX, e.clientY); e.preventDefault(); });
  addEventListener("pointermove", (e) => { if (drag) fromPoint(e.clientX, e.clientY); });
  addEventListener("pointerup", () => { drag = false; });
  render();

  return { lev: () => lev, onChange: (fn) => (cb = fn) };
}
