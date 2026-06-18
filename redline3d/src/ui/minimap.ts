export interface MiniState {
  hist: number[];
  inRun: boolean;
  equity: number;
  entryPx: number;
  liqPx: number; // 0 when n/a
  dir: 1 | -1;
}

export interface Minimap {
  draw(s: MiniState): void;
}

const MINI_N = 300;

/** Port of the prototype minimap: SOL price line, scaled to history, with entry/liq overlays during a run. */
export function createMinimap(canvas: HTMLCanvasElement): Minimap {
  const c = canvas.getContext("2d")!;
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  return {
    draw(s) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== ((w * DPR) | 0) || canvas.height !== ((h * DPR) | 0)) {
        canvas.width = w * DPR; canvas.height = h * DPR; c.setTransform(DPR, 0, 0, DPR, 0, 0);
      }
      c.clearRect(0, 0, w, h);
      const hist = s.hist, n = hist.length;
      if (n < 2) return;

      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { const v = hist[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const pad = (hi - lo) * 0.18 || hi * 0.0008 || 1;
      lo -= pad; hi += pad;
      const rng = hi - lo || 1;
      const off = MINI_N - n;
      const X = (k: number) => (k / (MINI_N - 1)) * (w - 30);
      const Y = (v: number) => h - ((v - lo) / rng) * h;
      const col = s.inRun ? (s.equity >= 1 ? "46,230,166" : "255,77,109") : "77,166,255";

      if (s.inRun) {
        if (s.liqPx > 0) {
          const ly = Y(s.liqPx);
          if (ly >= 0 && ly <= h) {
            c.fillStyle = "rgba(255,77,109,.12)";
            if (s.dir > 0) c.fillRect(0, ly, w, h - ly); else c.fillRect(0, 0, w, ly);
            c.strokeStyle = "rgba(255,77,109,.6)"; c.setLineDash([2, 3]); c.lineWidth = 1;
            c.beginPath(); c.moveTo(0, ly); c.lineTo(w, ly); c.stroke(); c.setLineDash([]);
            c.fillStyle = "rgba(255,140,160,.95)"; c.font = "800 8px ui-monospace";
            c.fillText("LIQ " + s.liqPx.toFixed(2), w - 78, ly + (s.dir > 0 ? 11 : -4));
          }
        }
        const ey = Y(s.entryPx);
        if (ey >= 0 && ey <= h) {
          c.strokeStyle = "rgba(205,214,245,.5)"; c.setLineDash([4, 4]); c.lineWidth = 1;
          c.beginPath(); c.moveTo(0, ey); c.lineTo(w, ey); c.stroke(); c.setLineDash([]);
          c.fillStyle = "rgba(205,214,245,.62)"; c.font = "800 8px ui-monospace";
          c.fillText("ENTRY", 6, ey < 14 ? ey + 11 : ey - 4);
        }
      }

      c.beginPath();
      for (let i = 0; i < n; i++) { const x = X(off + i), y = Y(hist[i]); i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.strokeStyle = "rgb(" + col + ")"; c.lineWidth = 2.4; c.lineJoin = "round";
      c.shadowColor = "rgba(" + col + ",.7)"; c.shadowBlur = 8; c.stroke(); c.shadowBlur = 0;
      c.lineTo(X(off + n - 1), h); c.lineTo(X(off), h); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(" + col + ",.22)"); g.addColorStop(1, "rgba(" + col + ",0)");
      c.fillStyle = g; c.fill();

      // 2D DeLorean riding the latest price point, tilted to the local slope (port of the OG HTML)
      const lx = X(off + n - 1), ly = Y(hist[n - 1]);
      let ang = 0;
      if (n >= 2) ang = Math.atan2(ly - Y(hist[n - 2]), lx - X(off + n - 2));
      ang = Math.max(-0.5, Math.min(0.5, ang));
      c.save();
      c.translate(lx, ly);
      c.rotate(ang);
      // body — low stainless wedge silhouette, glowing in the P&L colour
      c.shadowColor = "rgb(" + col + ")"; c.shadowBlur = 8;
      c.fillStyle = "rgb(" + col + ")";
      c.beginPath();
      c.moveTo(-12, -3); c.lineTo(-11, -8); c.lineTo(-3, -9.2); c.lineTo(5, -8.2); c.lineTo(10, -4.6); c.lineTo(13, -3.6); c.lineTo(13, -3);
      c.closePath(); c.fill();
      c.shadowBlur = 0;
      // cabin glass
      c.fillStyle = "rgba(8,6,26,.85)";
      c.beginPath(); c.moveTo(-2.5, -7.6); c.lineTo(-2, -8.8); c.lineTo(3.8, -8.1); c.lineTo(4.6, -7.3); c.closePath(); c.fill();
      // wheels (dark tyre + glowing hub)
      c.fillStyle = "#0a0820";
      c.beginPath(); c.arc(-6.5, -2.6, 3, 0, 7); c.fill();
      c.beginPath(); c.arc(7, -2.6, 3, 0, 7); c.fill();
      c.fillStyle = "rgb(" + col + ")";
      c.beginPath(); c.arc(-6.5, -2.6, 1.3, 0, 7); c.fill();
      c.beginPath(); c.arc(7, -2.6, 1.3, 0, 7); c.fill();
      c.restore();

      c.textAlign = "right"; c.fillStyle = "rgb(" + col + ")"; c.fillText("$" + hist[n - 1].toFixed(2), w - 6, 12); c.textAlign = "left";
    },
  };
}
