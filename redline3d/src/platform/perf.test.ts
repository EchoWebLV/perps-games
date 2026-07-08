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
    expect(detectQuality({ nav: weakNav }).pixelRatioCap).toBe(1.5);
  });

  test("missing nav fields default to 4 (cores<=4 → low), matching the old behavior", () => {
    expect(detectQuality({ nav: {} }).tier).toBe("low");
  });

  test("bloom stays full-resolution on every tier (phones must look identical to desktop)", () => {
    for (const nav of [strongNav, weakNav]) {
      const q = detectQuality({ nav });
      expect(q.bloom).toBe(true);
      expect(q.bloomScale).toBe(1);
    }
  });

  test("weak GPU forces low even on a strong-RAM device (the Seeker case: 8GB/8-core Mali)", () => {
    const q = detectQuality({ nav: strongNav, gpuRenderer: "ARM Mali-G615 MC2" });
    expect(q.tier).toBe("low");
    expect(q.pixelRatioCap).toBe(1.5);
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
