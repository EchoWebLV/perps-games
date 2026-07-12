import { describe, expect, it } from "vitest";
import landingHtml from "../../index.html?raw";
import manifestText from "../../public/manifest.webmanifest?raw";
import viteConfig from "../../vite.config.ts?raw";
import caddyfileText from "../../Caddyfile?raw";
import railwayConfig from "../../../railway.toml?raw";

const gamePages = import.meta.glob("../../play/index.html", {
  eager: true,
  import: "default",
  query: "?raw",
});
const landingScripts = import.meta.glob("./main.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});
const landingStyles = import.meta.glob("./landing.css", {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("Perps Rider landing shell", () => {
  it("makes root the landing page with a direct game link", () => {
    const html = landingHtml;

    expect(html).toContain("data-landing-page");
    expect(html).toContain('href="/play/"');
    expect(html).toContain("A real perp you drive");
    expect(html).toContain("You can lose your play amount");
    expect(html).not.toContain('/src/main.ts');
  });

  it("offers judges a direct Seeker APK download", () => {
    expect(landingHtml).toContain('href="/downloads/perps-rider.apk"');
    expect(landingHtml).toContain("Download Seeker APK");
  });

  it("keeps the game shell at play and starts installed experiences there", () => {
    expect(Object.keys(gamePages)).toHaveLength(1);
    const gameHtml = Object.values(gamePages)[0] as string | undefined;
    expect(gameHtml).toContain('/src/main.ts');
    expect(JSON.parse(manifestText).start_url).toBe("/play/");
  });

  it("keeps the web-only landing bundle separate from the native app", () => {
    expect(Object.keys(landingScripts)).toHaveLength(1);
    expect(Object.keys(landingStyles)).toHaveLength(1);
    const entry = Object.values(landingScripts)[0] as string | undefined;
    expect(entry).not.toContain("@capacitor/core");
    expect(entry).not.toContain("location.replace");
    expect(entry).not.toContain('from "three"');
    expect(entry).not.toContain('from "../main"');
    expect(landingHtml).toContain('/src/landing/landing.css');
    expect(landingHtml).toContain('/src/landing/main.ts');
  });

  it("registers landing and play as explicit Vite entries", () => {
    expect(viteConfig).toContain('landing: fileURLToPath(new URL("index.html"');
    expect(viteConfig).toContain('play: fileURLToPath(new URL("play/index.html"');
  });

  it("routes the public play path to the game document", () => {
    expect(caddyfileText).toContain("@playRoot path /play /play/");
    expect(caddyfileText).toContain("rewrite @playRoot /play/index.html");
  });

  it("makes frontend changes eligible for Railway deployment", () => {
    expect(railwayConfig).toContain('"/redline3d/**"');
  });

  it("uses resilient native video loops for every tutorial step", () => {
    const videos = landingHtml.match(/<video\b[\s\S]*?<\/video>/g) ?? [];

    expect(videos).toHaveLength(3);
    for (const video of videos) {
      expect(video).toContain("data-tutorial-video");
      expect(video).toMatch(/autoplay[^>]*loop[^>]*muted[^>]*playsinline/);
      expect(video).toMatch(/poster="\/tutorial\/(market-side|leverage|cash-out)\.webp"/);
      expect(video).toContain('type="video/webm"');
      expect(video).toContain('type="video/mp4"');
      expect(video).toContain('aria-hidden="true"');
    }
    expect(landingHtml).not.toMatch(/<div class="step-media"><img/);
  });

  it("actively starts tutorial loops when motion is allowed", () => {
    const entry = Object.values(landingScripts)[0] as string;

    expect(entry).toContain("video.play().catch");
  });

  it("offers a persistent motion control that responds to system and page visibility", () => {
    expect(landingHtml).toContain("data-motion-toggle");
    expect(landingHtml).toContain('aria-pressed="true"');
    const entry = Object.values(landingScripts)[0] as string;
    expect(entry).toContain('"perps-rider:motion-paused"');
    expect(entry).toContain('reduceMotion.addEventListener("change"');
    expect(entry).toContain('addEventListener("visibilitychange"');
    expect(landingHtml).toContain('data-motion-section="tutorial"');
    expect(landingHtml).toContain('data-motion-section="technology"');
  });

  it("shows real model renders for all four Strip buildings", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const landingStylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    for (const building of ["track", "garage", "upgrades", "crates"]) {
      expect(landingHtml).toContain(`src="/assets/landing/building-${building}.webp"`);
    }
    expect(landingHtml.match(/class="strip-building"/g)).toHaveLength(4);
    expect(landingHtml.match(/width="1024" height="720"/g)).toHaveLength(4);
    expect(landingHtml.match(/loading="lazy" decoding="async" alt=""/g)).toHaveLength(4);
    expect(landingHtml).not.toContain("building-shell");
    expect(landingHtml).not.toContain("building-coil");
    expect(landingHtml).not.toContain("crate-stack");
    expect(landingStylesheet).toContain("--building-render-scale: 1.28;");
    expect(landingStylesheet).toMatch(
      /\.strip-building img \{[^}]*transform: scale\(var\(--building-render-scale\)\);[^}]*\}/,
    );
    expect(landingStylesheet).toMatch(
      /\.stop-grid article:hover \.strip-building img \{[^}]*translateY\(-5px\) scale\(calc\(var\(--building-render-scale\) \* 1\.035\)\)[^}]*\}/,
    );
    expect(landingStylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.stop-grid article:hover \.strip-building img \{[^}]*transform: scale\(var\(--building-render-scale\)\);[^}]*\}/,
    );
  });

  it("provides a dependency-free reactive motion field", () => {
    for (const layer of ["plasma", "grid", "streaks", "particles"]) {
      expect(landingHtml).toContain(`motion-layer motion-${layer}`);
    }
    expect(landingHtml).toContain("data-motion-bg");

    const entry = Object.values(landingScripts)[0] as string;
    expect(entry).toContain('addEventListener("pointermove"');
    expect(entry).toContain('addEventListener("deviceorientation"');
    expect(entry).toContain("requestAnimationFrame");
    expect(entry).toContain('setProperty("--motion-x"');
    expect(entry).toContain('setProperty("--motion-y"');
    expect(entry).not.toContain('from "three"');
  });

});
