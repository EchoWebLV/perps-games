import { describe, expect, it } from "vitest";
import packageText from "../../package.json?raw";

const rendererHtmlFiles = import.meta.glob("../../building-renderer.html", { eager: true, import: "default", query: "?raw" });
const rendererSourceFiles = import.meta.glob("./building-renderer.ts", { eager: true, import: "default", query: "?raw" });
const captureSourceFiles = import.meta.glob("../../scripts/render-landing-buildings.mjs", { eager: true, import: "default", query: "?raw" });

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
});
