export interface FpsMeter {
  /** feed the rAF timestamp every frame — a cheap no-op when the meter is disabled */
  tick(nowMs: number): void;
  /** smoothed frames-per-second (EMA); 0 until the first full frame interval */
  fps(): number;
  /** the DOM chip — present only when enabled */
  el?: HTMLElement;
}

const ALPHA = 0.1; // EMA weight per frame — smooth enough to read, quick enough to trust
const DRAW_MS = 250; // DOM writes at most ~4x/sec; the EMA still updates every frame
const MAX_DT_MS = 1000; // tab-switch guard: a backgrounded rAF gap must not poison the EMA

/**
 * `?fps` diagnostic chip — the on-device frame-rate readout for perf-tier tuning
 * (the Seeker's WebView has no devtools overlay). Without the flag nothing mounts
 * and tick() is inert, so shipping it costs the player path nothing.
 *
 * `VITE_FPS=1` (or "true") is the build-time equivalent for the APK, whose WebView loads a
 * fixed https://localhost/ with no address bar to carry `?fps` on-device. A present `?fps`
 * param still enables; an explicit `opts.enabled` boolean wins over both. `envFps` is injectable
 * for tests and defaults to `import.meta.env?.VITE_FPS`.
 */
export function createFpsMeter(
  parent: HTMLElement,
  opts?: { enabled?: boolean; search?: string; envFps?: string },
): FpsMeter {
  const envFps = opts?.envFps ?? (import.meta.env?.VITE_FPS as string | undefined);
  const enabled =
    opts?.enabled ??
    (new URLSearchParams(opts?.search ?? globalThis.location?.search ?? "").has("fps") ||
      envFps === "1" ||
      envFps === "true");
  if (!enabled) return { tick() {}, fps: () => 0 };

  const el = document.createElement("div");
  el.className = "pe panel";
  el.setAttribute("aria-label", "Frames per second");
  el.style.cssText = [
    "position:absolute",
    "top:244px", // stacked under the scrap chip (scrap: top 194 + 42h + 8 gap)
    "left:max(12px,env(safe-area-inset-left))",
    "z-index:8",
    "min-width:74px",
    "height:42px",
    "padding:5px 10px 6px",
    "display:flex",
    "flex-direction:column",
    "justify-content:center",
    "align-items:center",
    "text-align:center",
    "border-radius:9px",
    "background:rgba(12,10,26,.74)",
  ].join(";");
  el.innerHTML = `
    <span class="lbl" style="font-size:8px;letter-spacing:.15em;line-height:1">fps</span>
    <span class="num" style="font-size:17px;line-height:1.08;color:var(--cyan);text-shadow:0 0 11px rgba(39,231,255,.55)">—</span>`;
  const num = el.querySelector(".num") as HTMLElement;
  parent.appendChild(el);

  let last: number | undefined;
  let ema = 0;
  let lastDraw = -Infinity;
  return {
    el,
    fps: () => ema,
    tick(nowMs) {
      const prev = last;
      last = nowMs;
      if (prev === undefined) return;
      const dt = nowMs - prev;
      if (dt <= 0 || dt > MAX_DT_MS) return; // duplicate timestamp / backgrounded tab
      const inst = 1000 / dt;
      ema = ema === 0 ? inst : ema + ALPHA * (inst - ema);
      if (nowMs - lastDraw >= DRAW_MS) {
        lastDraw = nowMs;
        num.textContent = String(Math.round(ema));
      }
    },
  };
}
