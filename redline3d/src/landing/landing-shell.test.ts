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
const brandAssets = import.meta.glob("../../public/assets/brands/*.svg", {
  eager: true,
  import: "default",
  query: "?raw",
});
const brandDocs = import.meta.glob("../../public/assets/brands/README.md", {
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

  it("ships canonical local MagicBlock and Solana marks", async () => {
    const nodeCrypto = "node:crypto";
    const { createHash } = await import(nodeCrypto);
    const magicblock = brandAssets["../../public/assets/brands/magicblock-logo.svg"] as string | undefined;
    const solana = brandAssets["../../public/assets/brands/solana-mark.svg"] as string | undefined;
    const sources = Object.values(brandDocs)[0] as string | undefined;

    expect(Object.keys(brandAssets)).toHaveLength(2);
    expect(magicblock).toContain('viewBox="0 0 162 32"');
    expect(magicblock).toContain('fill="white"');
    expect(solana).toContain('viewBox="0 0 101 88"');
    expect(solana).toContain('stop-color="#9945FF"');
    expect(solana).toContain('stop-color="#19FB9B"');
    expect(createHash("sha256").update(magicblock ?? "").digest("hex")).toBe(
      "adb0d0abd1ba7161d784c222d7a4821667e6b7b343e9810ceed39736fc03017c",
    );
    expect(createHash("sha256").update(solana ?? "").digest("hex")).toBe(
      "3d3401109aa061dec40a8659f1847817a8e647f98de1e65e76e86a95bbe1f08a",
    );
    expect(sources).toContain("https://www.magicblock.xyz/");
    expect(sources).toContain("https://solana.com/branding");
    expect(sources).toContain(
      "https://cdn.prod.website-files.com/67dd3f471f62a240dd544dd8/682efe2b89d00ecb838fa333_Frame%2085.svg",
    );
    expect(sources).toContain("https://solana.com/src/img/branding/solanaLogoMark.svg");
    expect(sources).toContain("Retrieved: 2026-07-13");
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

  it("presents a four-stage animated technology pipeline", () => {
    for (const scene of ["price", "execution", "settlement", "world"]) {
      expect(landingHtml).toContain(`data-tech-scene="${scene}"`);
    }
    expect(landingHtml.match(/class="tech-scene/g)).toHaveLength(4);
    expect(landingHtml.match(/<svg/g)).toHaveLength(4);
    expect(landingHtml).toContain("Social Open World");
    expect(landingHtml).toContain("Drive the Strip with other traders, show off your garage, and enter shared destinations together.");
    expect(landingHtml).not.toContain("<canvas");
  });

  it("anchors the cinematic pipeline with canonical technology marks", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(landingHtml).toContain('src="/assets/brands/magicblock-logo.svg"');
    expect(landingHtml).toContain('data-tech-brand="magicblock"');
    expect(landingHtml).toContain('src="/assets/brands/solana-mark.svg"');
    expect(landingHtml).toContain('data-tech-brand="solana"');
    expect(landingHtml.match(/class="pipeline-pulse"/g)).toHaveLength(1);
    for (const hook of ["price-ticker", "rollup-chamber", "settlement-gate", "world-destination"]) {
      expect(landingHtml).toContain(`class="${hook}`);
    }
    expect(landingHtml.match(/class="tech-brand/g)).toHaveLength(2);
    expect(landingHtml.match(/class="tech-scene/g)).toHaveLength(4);
    expect(landingHtml.match(/<svg/g)).toHaveLength(4);
    expect(stylesheet).toContain("@keyframes tx-ingest");
    expect(stylesheet).toContain("@keyframes settlement-converge");
    expect(stylesheet).toContain("@keyframes world-arrival");
    expect(stylesheet).toContain("@keyframes pipeline-travel");
    expect(stylesheet).toMatch(/\.tech-brand-solana \{[^}]*filter: none;/);
    expect(stylesheet).toMatch(
      /@media \(max-width: 760px\) \{[\s\S]*?\.tx-shard-b,[\s\S]*?\.tx-shard-c \{[^}]*display: none;/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 760px\) \{[\s\S]*?\.driver-a \{[^}]*--driver-x: -38px;/,
    );
    expect(stylesheet).not.toMatch(/@keyframes[^}]*background-position/);
    expect(landingHtml).not.toContain("<canvas");
  });

  it("locks technology scenes to the responsive motion contract", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const landingStylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");
    const decorativeScenes = landingHtml.match(/<div class="tech-scene[^>]*aria-hidden="true">/g) ?? [];

    expect(decorativeScenes).toHaveLength(4);
    for (const delay of ["0s", ".35s", ".7s", "1.05s"]) {
      expect(landingHtml).toContain(`style="--tech-delay: ${delay}"`);
    }
    expect(landingStylesheet).toMatch(
      /:where\(html\.motion-paused, html:not\(\.tech-motion-active\)\) \.tech-scene \*:not\(\.tech-brand\) \{[^}]*animation-play-state: paused !important;/,
    );
    expect(landingStylesheet).toMatch(/\.tech-grid \{[^}]*grid-template-columns: repeat\(4, 1fr\);/);
    expect(landingStylesheet).toMatch(
      /@media \(max-width: 1100px\) \{[\s\S]*?\.tech-grid \{[^}]*grid-template-columns: repeat\(2, 1fr\);/,
    );
    expect(landingStylesheet).toMatch(
      /@media \(max-width: 760px\) \{[\s\S]*?\.tech-grid \{[^}]*grid-template-columns: 1fr;/,
    );
    expect(landingStylesheet).toMatch(/\.car-b \{[^}]*--tech-phase-delay: 1\.2s;/);
    expect(landingStylesheet).toMatch(
      /\.tech-scene \*:not\(\.tech-brand\) \{[^}]*animation-delay: calc\(var\(--tech-delay, 0s\) \+ var\(--tech-phase-delay, 0s\)\);/,
    );
  });

  it("keeps branded scenes deterministic, unfiltered, and correctly staggered", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(stylesheet).toMatch(
      /:where\(html\.motion-paused, html:not\(\.tech-motion-active\)\) \.tech-scene \*:not\(\.tech-brand\) \{[^}]*animation-play-state: paused !important;[^}]*animation: none !important;/,
    );
    expect(stylesheet).toMatch(
      /:where\(html\.motion-paused, html:not\(\.tech-motion-active\)\) \.pipeline-pulse \{[^}]*animation-play-state: paused !important;[^}]*animation: none !important;/,
    );

    const staticStateRule = stylesheet.match(
      /:where\(html\.motion-paused, html:not\(\.tech-motion-active\)\) \.tech-scene :is\(([\s\S]*?)\) \{([^}]*)\}/,
    );
    expect(staticStateRule).not.toBeNull();
    for (const hook of [
      ".price-ticker b",
      ".rollup-pressure",
      ".tx-shard",
      ".settlement-rail",
      ".settlement-seal",
      ".world-destination i",
      ".city-windows rect",
      ".driver",
    ]) {
      expect(staticStateRule?.[1]).toContain(hook);
    }
    expect(staticStateRule?.[2]).toContain("opacity: 1;");
    expect(staticStateRule?.[2]).toContain("transform: none;");

    const hoverRule = stylesheet.match(/\.tech-grid article:hover \{([^}]*)\}/);
    expect(hoverRule?.[1]).not.toMatch(/(?:^|[;\s])filter\s*:/);
    expect(hoverRule?.[1]).toContain("box-shadow:");
    expect(stylesheet).not.toMatch(/\.tech-grid article \{[^}]*transition:[^;}]*filter/);

    expect(stylesheet).not.toMatch(/\.tech-scene \* \{[^}]*animation-delay:/);
    for (const selector of ["tech-brand", "tech-brand-magicblock", "tech-brand-solana"]) {
      const rule = stylesheet.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`));
      expect(rule?.[1]).not.toContain("animation");
    }

    for (const [card, delay] of [[2, "0.08s"], [3, "0.16s"], [4, "0.24s"]] as const) {
      expect(stylesheet).toMatch(
        new RegExp(`\\.tech-grid article:nth-of-type\\(${card}\\)\\[data-reveal\\] \\{[^}]*transition-delay: ${delay};`),
      );
    }
    const expectedConnectorTravel = (viewportWidth: number) => (
      0.84 * Math.min(1180, viewportWidth - 48) - 52
    );
    const cssPulseTravel = (viewportWidth: number) => (
      Math.min(0.84 * viewportWidth - 40.32, 991.2) - 52
    );
    for (const viewportWidth of [1101, 1180, 1200, 1228, 1440, 1920]) {
      expect(Math.abs(cssPulseTravel(viewportWidth) - expectedConnectorTravel(viewportWidth))).toBeLessThan(0.001);
    }
    expect(stylesheet).toContain("calc(min(calc(84vw - 40.32px), 991.2px) - 52px)");
    expect(stylesheet).not.toContain("calc(min(84vw, 991px) - 52px)");
    expect(stylesheet).not.toContain("calc(84vw - 110px)");
    expect(stylesheet).not.toContain("calc(84vw - 80px)");
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

  it("provides a dependency-free compositor motion field with normalized input", () => {
    for (const layer of ["plasma", "grid", "streaks", "particles"]) {
      expect(landingHtml).toMatch(
        new RegExp(`<div class="motion-layer motion-${layer}">\\s*<span><\\/span>\\s*<\\/div>`),
      );
    }
    expect(landingHtml.match(/class="motion-layer motion-/g)).toHaveLength(4);
    expect(landingHtml).toContain("data-motion-bg");

    const entry = Object.values(landingScripts)[0] as string;
    const stylesheet = Object.values(landingStyles)[0] as string;
    expect(entry).toContain('addEventListener("pointermove"');
    expect(entry).toContain('addEventListener("deviceorientation"');
    expect(entry).toContain("requestAnimationFrame");
    expect(entry).toContain('setProperty("--motion-x", motionX.toFixed(3))');
    expect(entry).toContain('setProperty("--motion-y", motionY.toFixed(3))');
    expect(entry).not.toContain("--motion-near-x");
    expect(stylesheet).not.toContain("--motion-near-x");
    expect(stylesheet).not.toMatch(
      /@keyframes\s+[^\s{]+\s*\{(?:[^{}]|\{[^{}]*\})*background-position/,
    );
    expect(entry).not.toContain('from "three"');
  });

  it("keeps ambient compositor motion continuous across loop boundaries", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    for (const layer of ["grid", "streaks", "particles"]) {
      expect(stylesheet).toMatch(
        new RegExp(`\\.motion-${layer} > span \\{[^}]*animation: ambient-${layer} [^;]* infinite alternate;`),
      );
    }
  });

  it("resets pointer parallax on all motion layers for reduced motion", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.motion-plasma,\s*\.motion-grid,\s*\.motion-streaks,\s*\.motion-particles \{[^}]*transform: none;/,
    );
  });

});
