export interface Quality {
  tier: "low" | "high";
  bloom: boolean;
  /** bloom internal-resolution scale — lower = cheaper blur passes on weak GPUs */
  bloomScale: number;
  pixelRatioCap: number;
  /** content scaling: "reduced" thins decorative counts (stars/dust), trims the roving
   *  point-lights and distance-culls the deep lamp corridor — the low tier's draw-call
   *  diet. "full" leaves every module exactly as designed (the high-tier look is fixed). */
  detail: "full" | "reduced";
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
   * Injectable for tests; defaults to `import.meta.env?.VITE_PERF` when absent.
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
    // Bloom is the game's signature neon glow, so it stays ON for every tier. The low tier
    // runs the blur chain at HALF resolution (bloomScale 0.5 — the glow survives, ~¼ the
    // blurred fragments) and caps devicePixelRatio at 1.25: on-device measurement (Seeker,
    // Mali-G615 WebView) showed the full-res chain at dpr 1.5 swinging 70→22fps. The high
    // tier is byte-identical to the original config — devices that earn it match desktop.
    low
      ? { tier: "low", bloom: true, bloomScale: 0.5, pixelRatioCap: 1.25, detail: "reduced" }
      : { tier: "high", bloom: true, bloomScale: 1, pixelRatioCap: 2, detail: "full" };

  // `?perf=low|high` — same runtime escape hatch pattern as `?wallet=` (chain/wallet-select.ts),
  // so on-device measurement can force either tier without a rebuild.
  const forced = new URLSearchParams(signals.search ?? globalThis.location?.search ?? "").get("perf");
  if (forced === "low" || forced === "high") return q(forced === "low");

  // `VITE_PERF=low|high` build-time pin — a diagnostic APK build carries the tier lever the
  // address-bar-less WebView can't. The URL param above wins, so web debugging stays ergonomic.
  const envPerf = signals.envPerf ?? (import.meta.env?.VITE_PERF as string | undefined);
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
