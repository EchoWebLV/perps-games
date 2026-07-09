export interface Quality {
  tier: "low" | "high";
  bloom: boolean;
  /** bloom internal-resolution scale — lower = cheaper blur passes on weak GPUs. Only read
   *  when `bloom` is true (the low tier turns bloom off, so this value is inert there). */
  bloomScale: number;
  pixelRatioCap: number;
  /** content scaling: "reduced" thins decorative counts (stars/dust), trims the roving
   *  point-lights and distance-culls the deep lamp corridor — the low tier's draw-call
   *  diet. "full" leaves every module exactly as designed (the high-tier look is fixed). */
  detail: "full" | "reduced";
  /** optional rAF frame-rate cap in fps. Set on the low tier (30) so a thermally-throttled
   *  phone presents a steady cadence instead of sawtoothing 60→20; absent on high (every
   *  refresh). Enforced in main.ts's frame loop via `shouldRenderFrame`. */
  frameCapFps?: number;
  /** MSAA sample count for the post composer's render targets (render/post.ts). The 4× MSAA
   *  exists to stop desktop-DPR bloom shimmer; per that file's own note the aliasing "didn't
   *  show on the lower-res phone", so the low tier drops to 0 — same glow, none of the
   *  multisample resolve bandwidth (a large slice of the composer cost on Mali tilers). */
  postSamples: number;
}

/** Detection inputs, all injectable for tests. Absent fields fall back to the real browser. */
export interface QualitySignals {
  nav?: { deviceMemory?: number; hardwareConcurrency?: number };
  /** unmasked WebGL renderer string (see gpuRendererString) — catches weak GPUs behind strong CPUs */
  gpuRenderer?: string;
  /** location.search — `?perf=low|high` is a manual override that wins over detection */
  search?: string;
  /**
   * `VITE_PERF=low|high` build-time pin — the same tier lever as `?perf`, for the APK whose
   * WebView loads a fixed https://localhost/ with no address bar (so URL params are unreachable
   * on the exact device — the Seeker — we need to tune). A `?perf` param still wins over it.
   * Injectable for tests; defaults to `import.meta.env.VITE_PERF` when absent.
   */
  envPerf?: string;
  /** navigator.userAgent — when the GPU string is masked (extension unavailable), an Android
   *  UA is the honest "phone WebView" tell; defaults to the real navigator when absent */
  ua?: string;
}

/**
 * Known-weak GPU families by renderer string. The RAM/core sniff alone misreads devices
 * like the Solana Seeker: 8GB/8-core CPU (→ "high") strapped to a Mali-G615 that can't
 * hold 60fps at devicePixelRatio 2. The GPU string is the honest signal there.
 *  - mali / powervr: mobile-only families, all tiers weak for this scene
 *  - adreno below 700: mid/low Qualcomm; 7xx+ flagships keep the high tier
 *  - swiftshader / llvmpipe: software rasterizers — definitely low
 * Apple GPUs are deliberately NOT flagged (fast even on old iPhones).
 */
export function isWeakGpu(renderer: string): boolean {
  const r = renderer.toLowerCase();
  if (/mali|powervr|swiftshader|llvmpipe/.test(r)) return true;
  const adreno = /adreno\D*(\d+)/.exec(r);
  return adreno !== null && Number(adreno[1]) < 700;
}

/** Unmasked renderer string via WEBGL_debug_renderer_info; undefined when the extension
 *  (or the context) is unavailable — detection then degrades to the RAM/core sniff. */
export function gpuRendererString(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined,
): string | undefined {
  try {
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return undefined;
    const s = gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    return typeof s === "string" && s ? s : undefined;
  } catch {
    return undefined;
  }
}

export function detectQuality(signals: QualitySignals = {}): Quality {
  const q = (low: boolean): Quality =>
    // Bloom stays ON for every tier: the whole scene's look is authored through the post
    // chain, and shipping without it reads as "all dark" (proven on the Seeker 2026-07-08 —
    // a bloom:false low tier was built, seen on-device, and reverted same day; don't retry it).
    // The low tier instead cheapens the SAME look: half-res blur chain (bloomScale 0.5),
    // composer MSAA off (postSamples 0 — the desktop-DPR shimmer it prevents doesn't show at
    // phone resolution, and the multisample resolve is a big slice of the composer's Mali
    // cost), dpr cap 1.25, and a 30fps cadence cap for thermal headroom. The high tier is
    // byte-identical to the original config — devices that earn it match desktop.
    low
      ? { tier: "low", bloom: true, bloomScale: 0.5, pixelRatioCap: 1.25, detail: "reduced", frameCapFps: 30, postSamples: 0 }
      : { tier: "high", bloom: true, bloomScale: 1, pixelRatioCap: 2, detail: "full", postSamples: 4 };

  // `?perf=low|high` — same runtime escape hatch pattern as `?wallet=` (chain/wallet-select.ts),
  // so on-device measurement can force either tier without a rebuild.
  const forced = new URLSearchParams(signals.search ?? globalThis.location?.search ?? "").get("perf");
  if (forced === "low" || forced === "high") return q(forced === "low");

  // `VITE_PERF=low|high` build-time pin — a diagnostic APK build carries the tier lever the
  // address-bar-less WebView can't. The URL param above wins, so web debugging stays ergonomic.
  // exact member access (no `?.`) — same static-replacement constraint as VITE_FPS (fpsmeter.ts)
  const envPerf = signals.envPerf ?? (import.meta.env.VITE_PERF as string | undefined);
  if (envPerf === "low" || envPerf === "high") return q(envPerf === "low");

  const nav =
    signals.nav ?? (globalThis.navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number } | undefined);
  const mem = nav?.deviceMemory ?? 4;
  const cores = nav?.hardwareConcurrency ?? 4;
  const weakGpu = signals.gpuRenderer !== undefined && isWeakGpu(signals.gpuRenderer);
  // Android WebViews can mask WEBGL_debug_renderer_info entirely — then the RAM/core sniff
  // alone lands HIGH on the Seeker's 8GB/8-core (strapped to a Mali). With no GPU string to
  // read, an Android UA defaults to low; a present renderer string (either verdict) wins.
  const ua = signals.ua ?? globalThis.navigator?.userAgent ?? "";
  const maskedAndroid = signals.gpuRenderer === undefined && /android/i.test(ua);
  return q(weakGpu || maskedAndroid || mem <= 3 || cores <= 4);
}

/**
 * Frame-cap gate for the low tier's rAF loop: true when enough wall-clock has elapsed since
 * the last *rendered* frame to present another at ~`capFps`. Pure/injectable so main.ts can
 * time-skip frames (schedule the next rAF, run no frame body) without duplicating the math.
 *
 * The small `toleranceMs` (default 1ms) absorbs rAF jitter: on a 60Hz display frames arrive
 * ~16.67ms apart, and a 30fps budget is 33.33ms — a frame landing a hair under budget (e.g.
 * 33.1ms) must still count, or the cadence beats against the cap and halves to 20fps. A
 * missing/invalid cap (0, NaN, ≤0 — the high tier's undefined) never gates: always render.
 */
export function shouldRenderFrame(
  lastRenderMs: number,
  nowMs: number,
  capFps: number | undefined,
  toleranceMs = 1,
): boolean {
  if (!capFps || capFps <= 0) return true; // no cap → present every frame
  return nowMs - lastRenderMs >= 1000 / capFps - toleranceMs;
}
