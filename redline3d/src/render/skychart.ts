import * as THREE from "three";

export interface Candle { o: number; h: number; l: number; c: number; }

export interface SkyChart {
  mesh: THREE.Mesh;
  /** repaint the chart from a candle series (swap in real 15m data here later) */
  redraw(candles: Candle[]): void;
}

const TEX_W = 1024, TEX_H = 480;

/** procedural OHLC so we can approve the look before wiring a real 15m feed */
function mockCandles(): Candle[] {
  const n = 56;
  const out: Candle[] = [];
  let p = 69 + Math.random() * 5;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = Math.max(1, o + (Math.random() - 0.47) * 0.55);
    const h = Math.max(o, c) + Math.random() * 0.28;
    const l = Math.min(o, c) - Math.random() * 0.28;
    out.push({ o, h, l, c });
    p = c;
  }
  return out;
}

/** A faded "pro" candlestick chart sitting far back in the sky as ambient backdrop. */
export function createSkyChart(): SkyChart {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const cx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.16, depthWrite: false, fog: false });
  const aspect = TEX_H / TEX_W;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(860, 860 * aspect), mat);
  mesh.position.set(0, 205, -865); // behind the sun/mountains, high in the sky
  mesh.renderOrder = -1;

  function redraw(cs: Candle[]) {
    cx.clearRect(0, 0, TEX_W, TEX_H);
    if (cs.length < 2) { tex.needsUpdate = true; return; }
    const padL = 14, padR = 96, padT = 44, padB = 30;
    const x0 = padL, x1 = TEX_W - padR, y0 = padT, y1 = TEX_H - padB;
    let lo = Infinity, hi = -Infinity;
    for (const k of cs) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const rng = hi - lo || 1;
    const Y = (v: number) => y1 - ((v - lo) / rng) * (y1 - y0);
    const n = cs.length, step = (x1 - x0) / n, bw = Math.max(3, step * 0.62);

    // grid + right-edge price scale
    cx.lineWidth = 1;
    cx.font = "500 17px 'Chakra Petch', ui-monospace, monospace";
    cx.textAlign = "left";
    for (let g = 0; g <= 4; g++) {
      const yy = y0 + ((y1 - y0) * g) / 4;
      cx.strokeStyle = "rgba(150,170,235,0.12)";
      cx.beginPath(); cx.moveTo(x0, yy); cx.lineTo(x1, yy); cx.stroke();
      cx.fillStyle = "rgba(175,190,240,0.55)";
      cx.fillText("$" + (hi - ((hi - lo) * g) / 4).toFixed(2), x1 + 9, yy + 5);
    }
    for (let g = 0; g <= 6; g++) {
      const xx = x0 + ((x1 - x0) * g) / 6;
      cx.strokeStyle = "rgba(150,170,235,0.07)";
      cx.beginPath(); cx.moveTo(xx, y0); cx.lineTo(xx, y1); cx.stroke();
    }

    // candles
    for (let i = 0; i < n; i++) {
      const k = cs[i], xc = x0 + step * (i + 0.5), up = k.c >= k.o;
      const col = up ? "rgba(46,230,166,0.95)" : "rgba(255,92,120,0.95)";
      cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = Math.max(1, bw * 0.16);
      cx.beginPath(); cx.moveTo(xc, Y(k.h)); cx.lineTo(xc, Y(k.l)); cx.stroke();
      const yo = Y(k.o), yc = Y(k.c);
      cx.fillRect(xc - bw / 2, Math.min(yo, yc), bw, Math.max(2, Math.abs(yc - yo)));
    }

    // moving-average line
    cx.strokeStyle = "rgba(130,205,255,0.75)"; cx.lineWidth = 2; cx.beginPath();
    const P = 9;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - P + 1); j <= i; j++) { s += cs[j].c; c++; }
      const xc = x0 + step * (i + 0.5), yy = Y(s / c);
      i ? cx.lineTo(xc, yy) : cx.moveTo(xc, yy);
    }
    cx.stroke();

    // header
    cx.fillStyle = "rgba(185,200,245,0.85)";
    cx.font = "700 24px 'Chakra Petch', ui-monospace, monospace";
    cx.fillText("SOL · 15M", x0, y0 - 16);

    tex.needsUpdate = true;
  }

  redraw(mockCandles());
  return { mesh, redraw };
}
