import { describe, expect, test } from "vitest";
import { detectQuality, gpuRendererString, isWeakGpu } from "./perf";

// All signals injected — nothing here touches the real navigator/location.
const strongNav = { deviceMemory: 8, hardwareConcurrency: 8 };
const weakNav = { deviceMemory: 2, hardwareConcurrency: 8 };

describe("detectQuality", () => {
  test("RAM/core rule unchanged when no GPU signal: strong device is high, weak is low", () => {
    expect(detectQuality({ nav: strongNav }).tier).toBe("high");
    expect(detectQuality({ nav: strongNav }).pixelRatioCap).toBe(2);
    expect(detectQuality({ nav: weakNav }).tier).toBe("low");
    expect(detectQuality({ nav: { deviceMemory: 8, hardwareConcurrency: 4 } }).tier).toBe("low");
    expect(detectQuality({ nav: weakNav }).pixelRatioCap).toBe(1.25);
  });

  test("missing nav fields default to 4 (cores<=4 → low), matching the old behavior", () => {
    expect(detectQuality({ nav: {} }).tier).toBe("low");
  });

  test("high tier is byte-identical to the original config: full-res bloom, dpr 2, full detail", () => {
    const q = detectQuality({ nav: strongNav });
    expect(q.bloom).toBe(true);
    expect(q.bloomScale).toBe(1);
    expect(q.pixelRatioCap).toBe(2);
    expect(q.detail).toBe("full");
  });

  test("low tier is actually light: bloom stays ON but at half resolution, tighter dpr, reduced detail", () => {
    const q = detectQuality({ nav: weakNav });
    expect(q.bloom).toBe(true); // the neon look survives on low — just a cheaper blur chain
    expect(q.bloomScale).toBe(0.5);
    expect(q.pixelRatioCap).toBe(1.25);
    expect(q.detail).toBe("reduced");
  });

  test("weak GPU forces low even on a strong-RAM device (the Seeker case: 8GB/8-core Mali)", () => {
    const q = detectQuality({ nav: strongNav, gpuRenderer: "ARM Mali-G615 MC2" });
    expect(q.tier).toBe("low");
    expect(q.pixelRatioCap).toBe(1.25);
  });

  test("strong GPU does not rescue a weak-RAM device (existing rule still applies)", () => {
    const q = detectQuality({ nav: weakNav, gpuRenderer: "NVIDIA GeForce RTX 3080/PCIe/SSE2" });
    expect(q.tier).toBe("low");
  });

  test("strong GPU + strong device stays high", () => {
    expect(detectQuality({ nav: strongNav, gpuRenderer: "Apple GPU" }).tier).toBe("high");
    expect(detectQuality({ nav: strongNav, gpuRenderer: "ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)" }).tier).toBe("high");
  });

  test("?perf override wins over detection in both directions", () => {
    // forced low on a machine that detects high
    expect(detectQuality({ nav: strongNav, gpuRenderer: "Apple GPU", search: "?perf=low" }).tier).toBe("low");
    // forced high on a machine that detects low (weak GPU AND weak RAM)
    expect(detectQuality({ nav: weakNav, gpuRenderer: "ARM Mali-G615", search: "?perf=high" }).tier).toBe("high");
    // coexists with other params
    expect(detectQuality({ nav: strongNav, search: "?fps&perf=low" }).tier).toBe("low");
  });

  test("unknown ?perf values are ignored — detection applies", () => {
    expect(detectQuality({ nav: strongNav, search: "?perf=medium" }).tier).toBe("high");
    expect(detectQuality({ nav: weakNav, search: "?perf=" }).tier).toBe("low");
  });

  // Build-time pin for the APK, whose WebView loads a fixed https://localhost/ with no
  // address bar — `?perf` is unreachable on the exact device (Seeker) we need to tune.
  test("VITE_PERF env pin acts like ?perf when no param is present (both directions)", () => {
    // env low forces low on a machine that detects high
    const low = detectQuality({ nav: strongNav, gpuRenderer: "Apple GPU", envPerf: "low" });
    expect(low.tier).toBe("low");
    expect(low.pixelRatioCap).toBe(1.25);
    // env high forces high on a machine that detects low (weak GPU AND weak RAM)
    expect(detectQuality({ nav: weakNav, gpuRenderer: "ARM Mali-G615", envPerf: "high" }).tier).toBe("high");
  });

  test("a ?perf param beats the VITE_PERF env pin in both directions (URL wins so web debugging stays ergonomic)", () => {
    expect(detectQuality({ nav: strongNav, envPerf: "high", search: "?perf=low" }).tier).toBe("low");
    expect(detectQuality({ nav: weakNav, envPerf: "low", search: "?perf=high" }).tier).toBe("high");
  });

  test("unknown/empty VITE_PERF is ignored — detection applies (explicit injected env isolates the real one)", () => {
    expect(detectQuality({ nav: strongNav, envPerf: "medium" }).tier).toBe("high");
    expect(detectQuality({ nav: strongNav, envPerf: "" }).tier).toBe("high"); // neither param nor pin → detection
    expect(detectQuality({ nav: weakNav, envPerf: "" }).tier).toBe("low");
  });

  // The Seeker's WebView can mask WEBGL_debug_renderer_info entirely — no renderer string at
  // all. Its 8GB/8-core CPU then sails through the RAM/core sniff and lands HIGH on a
  // Mali-G615. With the GPU signal gone, an Android UA is the honest "phone WebView" tell.
  describe("Android UA fallback when the GPU string is masked", () => {
    const seekerUA = "Mozilla/5.0 (Linux; Android 14; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    const macUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    test("no renderer string + Android UA → low, even on strong RAM/cores (the Seeker WebView case)", () => {
      const q = detectQuality({ nav: strongNav, ua: seekerUA });
      expect(q.tier).toBe("low");
      expect(q.bloomScale).toBe(0.5);
    });

    test("a present renderer string still decides — a flagship Adreno keeps high on Android", () => {
      expect(detectQuality({ nav: strongNav, ua: seekerUA, gpuRenderer: "ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)" }).tier).toBe("high");
    });

    test("no renderer string on a non-Android UA keeps the plain RAM/core sniff", () => {
      expect(detectQuality({ nav: strongNav, ua: macUA }).tier).toBe("high");
      expect(detectQuality({ nav: weakNav, ua: macUA }).tier).toBe("low");
    });

    test("?perf=high and the VITE_PERF pin still override the Android fallback", () => {
      expect(detectQuality({ nav: strongNav, ua: seekerUA, search: "?perf=high" }).tier).toBe("high");
      expect(detectQuality({ nav: strongNav, ua: seekerUA, envPerf: "high" }).tier).toBe("high");
    });
  });
});

describe("isWeakGpu", () => {
  test("flags known-weak mobile GPU families", () => {
    expect(isWeakGpu("ARM Mali-G615 MC2")).toBe(true); // the Seeker
    expect(isWeakGpu("ANGLE (ARM, Mali-G78, OpenGL ES 3.2)")).toBe(true);
    expect(isWeakGpu("Adreno (TM) 640")).toBe(true);
    expect(isWeakGpu("ANGLE (Qualcomm, Adreno (TM) 305, OpenGL ES 3.0)")).toBe(true);
    expect(isWeakGpu("PowerVR Rogue GE8320")).toBe(true);
  });

  test("flags software rasterizers", () => {
    expect(isWeakGpu("Google SwiftShader")).toBe(true);
    expect(isWeakGpu("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
  });

  test("does not flag strong GPUs (Adreno 7xx+, Apple, desktop)", () => {
    expect(isWeakGpu("Adreno (TM) 730")).toBe(false);
    expect(isWeakGpu("ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)")).toBe(false);
    expect(isWeakGpu("Apple GPU")).toBe(false);
    expect(isWeakGpu("Apple M1")).toBe(false);
    expect(isWeakGpu("NVIDIA GeForce RTX 3080/PCIe/SSE2")).toBe(false);
    expect(isWeakGpu("")).toBe(false);
  });
});

describe("gpuRendererString", () => {
  const UNMASKED = 0x9246;
  const fakeGl = (opts: { ext?: boolean; value?: unknown; throws?: boolean }) =>
    ({
      getExtension: (name: string) =>
        opts.ext !== false && name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: UNMASKED } : null,
      getParameter: (p: number) => {
        if (opts.throws) throw new Error("context lost");
        return p === UNMASKED ? opts.value : null;
      },
    }) as unknown as WebGLRenderingContext;

  test("returns the unmasked renderer string when the extension is available", () => {
    expect(gpuRendererString(fakeGl({ value: "ARM Mali-G615" }))).toBe("ARM Mali-G615");
  });

  test("returns undefined when the extension is missing (e.g. Firefox), the context is gone, or the query throws", () => {
    expect(gpuRendererString(fakeGl({ ext: false }))).toBeUndefined();
    expect(gpuRendererString(fakeGl({ value: "" }))).toBeUndefined();
    expect(gpuRendererString(fakeGl({ throws: true }))).toBeUndefined();
    expect(gpuRendererString(null)).toBeUndefined();
    expect(gpuRendererString(undefined)).toBeUndefined();
  });
});
