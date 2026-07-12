import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import packageText from "../../package.json?raw";

const rendererHtmlFiles = import.meta.glob("../../building-renderer.html", { eager: true, import: "default", query: "?raw" });
const rendererSourceFiles = import.meta.glob("./building-renderer.ts", { eager: true, import: "default", query: "?raw" });
const captureSourceFiles = import.meta.glob("../../scripts/render-landing-buildings.mjs", { eager: true, import: "default", query: "?raw" });

const readU24 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

describe("landing building renderer", () => {
  it("renders the real game buildings through a transparent orthographic scene", () => {
    expect(Object.keys(rendererHtmlFiles)).toHaveLength(1);
    expect(Object.keys(rendererSourceFiles)).toHaveLength(1);
    const rendererHtml = Object.values(rendererHtmlFiles)[0] as string;
    const rendererSource = Object.values(rendererSourceFiles)[0] as string;
    expect(rendererHtml).toContain('/src/landing/building-renderer.ts');
    for (const builder of ["buildTrack", "buildGarage", "buildUpgrades", "buildCrates"]) {
      expect(rendererSource).toContain(builder);
    }
    expect(rendererSource).toContain("OrthographicCamera");
    expect(rendererSource).toContain("alpha: true");
    expect(rendererSource).toContain('dataset.ready = "true"');
  });

  it("captures every building as a committed WebP", () => {
    expect(Object.keys(captureSourceFiles)).toHaveLength(1);
    const captureSource = Object.values(captureSourceFiles)[0] as string;
    for (const building of ["track", "garage", "upgrades", "crates"]) {
      expect(captureSource).toContain(`"${building}"`);
      expect(captureSource).toContain(`building-${building}.webp`);
    }
    expect(captureSource).toContain('type: "webp"');
    expect(captureSource).toContain("omitBackground: true");
    expect(JSON.parse(packageText).scripts["render:landing-buildings"]).toBe("node scripts/render-landing-buildings.mjs");
  });

  it("commits decodable alpha WebPs at the required dimensions", async () => {
    for (const building of ["track", "garage", "upgrades", "crates"]) {
      const bytes = await readFile(new URL(`../../public/assets/landing/building-${building}.webp`, import.meta.url));
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
      expect(bytes.subarray(12, 16).toString()).toBe("VP8X");
      expect(bytes[20] & 0x10).toBe(0x10);
      expect(readU24(bytes, 24) + 1).toBe(1024);
      expect(readU24(bytes, 27) + 1).toBe(720);
    }
  });
});
