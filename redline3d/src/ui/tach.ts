import { CONFIG } from "../core/config";

export interface Tach {
  /** drive the gauge from the throttle (0..1) + current leverage */
  setThrottle(frac: number, lev: number): void;
}

const CX = 160, CY = 170, R = 132;
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
function gcol(f: number): string {
  return f >= lf(REDLINE) ? "#ff4d6d" : f >= 0.42 ? "#ffd166" : "#2ee6a6";
}
/** graduation marks around the rim — hot (red) inside the redline zone */
function ticks(): string {
  const red = lf(REDLINE);
  let s = "";
  for (let i = 0; i <= 10; i++) {
    const f = i / 10;
    const major = i % 5 === 0;
    const [x1, y1] = pt(f, R + 3);
    const [x2, y2] = pt(f, R + (major ? 14 : 9));
    const hot = f >= red - 0.001;
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${hot ? "#ff4d6d" : "#6b79ad"}" stroke-width="${major ? 3 : 2}" stroke-linecap="round" opacity="${hot ? 0.95 : 0.5}"/>`;
  }
  return s;
}

/** Curved redline tachometer — a live, glowing readout of the throttle/leverage. */
export function createTach(mount: HTMLElement): Tach {
  mount.innerHTML = `
    <svg viewBox="0 0 320 190" style="width:100%;display:block;overflow:visible">
      <defs>
        <filter id="tglow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <linearGradient id="trev" gradientUnits="userSpaceOnUse" x1="${CX - R}" y1="0" x2="${CX + R}" y2="0">
          <stop offset="0" stop-color="#2ee6a6"/>
          <stop offset="0.5" stop-color="#ffd166"/>
          <stop offset="0.78" stop-color="#ff7b3d"/>
          <stop offset="1" stop-color="#ff4d6d"/>
        </linearGradient>
      </defs>
      ${ticks()}
      <path d="${arc(0, 1, R, 56)}" fill="none" stroke="#13182b" stroke-width="16" stroke-linecap="round"/>
      <path d="${arc(0, 1, R, 56)}" fill="none" stroke="url(#trev)" stroke-width="16" stroke-linecap="round" opacity="0.13"/>
      <circle cx="${CX}" cy="${CY}" r="16" fill="#0a0820" stroke="rgba(255,255,255,.16)" stroke-width="2"/>
      <g filter="url(#tglow)">
        <path d="${arc(lf(REDLINE), 1, R, 22)}" fill="none" stroke="#ff4d6d" stroke-width="16" stroke-linecap="round" opacity="0.5"/>
        <path id="tfill" fill="none" stroke="url(#trev)" stroke-width="16" stroke-linecap="round"/>
        <line id="tneedle" x1="${CX}" y1="${CY}" x2="${CX}" y2="46" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
        <circle id="thub" cx="${CX}" cy="${CY}" r="7" fill="#2ee6a6"/>
        <text id="tval" x="${CX}" y="146" text-anchor="middle" font-family="'Chakra Petch',ui-monospace,monospace" font-size="48" font-weight="700" fill="#2ee6a6">50×</text>
      </g>
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
      const tip = pt(f, R - 30);
      needle.setAttribute("x2", tip[0].toFixed(1));
      needle.setAttribute("y2", tip[1].toFixed(1));
      hub.setAttribute("fill", c);
      val.textContent = lev + "×";
      val.setAttribute("fill", c);
    },
  };
}
