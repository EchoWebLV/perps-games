export interface Fx {
  /** win / cash-out — a neon confetti burst */
  confetti(): void;
  /** liquidation — a "meh" beat: red flash, gray engine smoke, screen shake */
  liquidate(): void;
  /** Nitro Overdrive — a warp-speed streak burst + orange flash + kick */
  nitro(): void;
  /** Vaporwave — a floating "×N" multiplier that rises from screen point (x,y) ≈ above the car */
  coinPop(mult: number, x?: number, y?: number): void;
}

type P = {
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; r: number; color: string;
  life: number; max: number; grav: number; kind: "rect" | "smoke" | "streak" | "text";
  text?: string;
};

/**
 * Lightweight end-of-round effects on a transparent full-screen overlay canvas
 * (above the HUD, never intercepts input). The RAF loop only runs while
 * particles are alive, so it costs nothing between rounds.
 */
export function createFx(): Fx {
  const cv = document.createElement("canvas");
  cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:9;pointer-events:none";
  document.body.appendChild(cv);
  const g = cv.getContext("2d")!;

  let W = 0, H = 0;
  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const parts: P[] = [];
  let flash = 0, flashMax = 18, flashCol = "#ff2d55";
  let raf = 0;

  const loop = () => {
    g.clearRect(0, 0, W, H);
    let alive = false;

    if (flash > 0) {
      g.save();
      g.globalAlpha = (flash / flashMax) * 0.4;
      g.fillStyle = flashCol;
      g.fillRect(0, 0, W, H);
      g.restore();
      flash--;
      alive = true;
    }

    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.life--;
      p.vy += p.grav;
      p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy;
      p.rot += p.vr;
      const fade = Math.min(1, p.life / 28);
      g.save();
      g.globalAlpha = fade * (p.kind === "smoke" ? 0.45 : 1);
      g.translate(p.x, p.y);
      if (p.kind === "rect") {
        g.rotate(p.rot);
        g.shadowColor = p.color;
        g.shadowBlur = 14;
        g.fillStyle = p.color;
        g.fillRect(-p.r * 0.5, -p.r * 0.8, p.r, p.r * 1.6);
      } else if (p.kind === "streak") {
        g.rotate(Math.atan2(p.vy, p.vx)); // orient along motion → a trailing speed line
        g.strokeStyle = p.color;
        g.lineWidth = 3;
        g.lineCap = "round";
        g.shadowColor = p.color;
        g.shadowBlur = 12;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(-p.r, 0);
        g.stroke();
      } else if (p.kind === "text") {
        g.font = `800 ${p.r}px 'Chakra Petch',ui-monospace,monospace`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.shadowColor = p.color;
        g.shadowBlur = 16;
        g.lineWidth = 4;
        g.strokeStyle = "rgba(0,0,0,.55)";
        g.strokeText(p.text || "", 0, 0);
        g.fillStyle = p.color;
        g.fillText(p.text || "", 0, 0);
      } else {
        const rad = p.r * (1 + (1 - p.life / p.max) * 2.4);
        g.fillStyle = p.color;
        g.beginPath();
        g.arc(0, 0, rad, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }

    if (alive) {
      raf = requestAnimationFrame(loop);
    } else {
      g.clearRect(0, 0, W, H);
      parts.length = 0;
      raf = 0;
    }
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };

  const shake = () => {
    const gl = document.getElementById("gl");
    if (!gl) return;
    gl.classList.remove("fxshake");
    void gl.offsetWidth; // restart the animation
    gl.classList.add("fxshake");
    setTimeout(() => gl.classList.remove("fxshake"), 460);
  };

  return {
    confetti() {
      const cols = ["#27e7ff", "#ff39c0", "#2ee6a6", "#ffd166", "#a06bff"];
      const cx = W / 2, cy = H * 0.4;
      for (let i = 0; i < 150; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 12;
        parts.push({
          x: cx + (Math.random() - 0.5) * 70, y: cy + (Math.random() - 0.5) * 40,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 5,
          rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.6,
          r: 6 + Math.random() * 6, color: cols[i % cols.length],
          life: 80 + Math.random() * 70, max: 150, grav: 0.2, kind: "rect",
        });
      }
      start();
    },
    liquidate() {
      flash = 18; flashMax = 18; flashCol = "#ff2d55";
      const cx = W / 2, cy = H * 0.46;
      for (let i = 0; i < 16; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 0.4 + Math.random() * 1.8;
        const v = 58 + Math.floor(Math.random() * 46);
        parts.push({
          x: cx + (Math.random() - 0.5) * 60, y: cy + (Math.random() - 0.5) * 30,
          vx: Math.cos(ang) * sp, vy: -0.6 - Math.random() * 1.2,
          rot: 0, vr: 0, r: 14 + Math.random() * 16,
          color: `rgb(${v},${v},${v + 6})`,
          life: 50 + Math.random() * 40, max: 90, grav: -0.01, kind: "smoke",
        });
      }
      shake();
      start();
    },
    nitro() {
      flash = 14; flashMax = 14; flashCol = "#ff8a1a"; // brief orange whoosh
      const cx = W / 2, cy = H / 2;
      for (let i = 0; i < 48; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 15 + Math.random() * 24;       // fast outward warp lines
        const d0 = 30 + Math.random() * 110;       // start spread out from centre
        const c = i % 3 === 0 ? "#ffffff" : i % 3 === 1 ? "#ffd166" : "#ff7a3c";
        parts.push({
          x: cx + Math.cos(ang) * d0, y: cy + Math.sin(ang) * d0,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          rot: 0, vr: 0, r: 34 + Math.random() * 64, color: c,
          life: 15 + Math.random() * 12, max: 27, grav: 0, kind: "streak",
        });
      }
      shake();
      start();
    },
    coinPop(mult, x, y) {
      const col = mult >= 5 ? "#ff5ccf" : mult >= 3 ? "#27e7ff" : "#ffd166";
      parts.push({
        x: (x ?? W / 2) + (Math.random() - 0.5) * 18, y: y ?? H * 0.45,
        vx: (Math.random() - 0.5) * 0.6, vy: -1.7,
        rot: 0, vr: 0, r: mult >= 5 ? 54 : mult >= 3 ? 44 : 36,
        color: col, life: 46, max: 46, grav: 0.02, kind: "text", text: "×" + mult,
      });
      start();
    },
  };
}
