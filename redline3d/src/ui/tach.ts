import { CONFIG } from "../core/config";

export interface Tach {
  /** drive the gauge from the throttle (0..1) + current leverage */
  setThrottle(frac: number, lev: number): void;
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

/** Curved redline tachometer — a live readout of the throttle/leverage. */
export function createTach(mount: HTMLElement): Tach {
  mount.innerHTML = `
    <svg viewBox="0 0 320 184" style="width:100%;display:block">
      <path d="${arc(0, 1, R, 56)}" fill="none" stroke="#1a2036" stroke-width="16" stroke-linecap="round"/>
      <path d="${arc(lf(REDLINE), 1, R, 22)}" fill="none" stroke="rgba(255,77,109,.4)" stroke-width="16"/>
      <path id="tfill" fill="none" stroke="#2ee6a6" stroke-width="16" stroke-linecap="round"/>
      <line id="tneedle" x1="${CX}" y1="${CY}" x2="${CX}" y2="40" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
      <circle id="thub" cx="${CX}" cy="${CY}" r="11" fill="#0a0820" stroke="#2ee6a6" stroke-width="3"/>
      <text id="tval" x="${CX}" y="150" text-anchor="middle" font-family="'Chakra Petch',ui-monospace,monospace" font-size="46" font-weight="700" fill="#2ee6a6">50×</text>
    </svg>`;
  const fill = mount.querySelector("#tfill") as SVGPathElement;
  const needle = mount.querySelector("#tneedle") as SVGLineElement;
  const hub = mount.querySelector("#thub") as SVGCircleElement;
  const val = mount.querySelector("#tval") as SVGTextElement;

  return {
    setThrottle(frac, lev) {
      const f = Math.max(0, Math.min(1, frac));
      const c = gcol(f);
      fill.setAttribute("d", arc(0, Math.max(0.001, f), R, Math.max(2, Math.round(f * 56))));
      fill.setAttribute("stroke", c);
      const tip = pt(f, R - 34);
      needle.setAttribute("x2", tip[0].toFixed(1));
      needle.setAttribute("y2", tip[1].toFixed(1));
      needle.setAttribute("stroke", c);
      hub.setAttribute("stroke", c);
      val.textContent = lev + "×";
      val.setAttribute("fill", c);
    },
  };
}
