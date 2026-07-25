import { describe, expect, it } from "vitest";
import crateCinematicSrc from "../ui/crate-cinematic.ts?raw";
import demoCrateSrc from "./demo-crate.ts?raw";
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

describe("Slopwheels landing shell", () => {
  it("makes root the landing page with a direct game link", () => {
    const html = landingHtml;

    expect(html).toContain("data-landing-page");
    expect(html).toContain('href="/play/"');
    expect(html).toContain("Crack a crate");                 // was "A real perp you drive"
    expect(html).toContain("You can lose your play amount"); // risk note survives
    expect(html).not.toContain('/src/main.ts');
    expect(html).not.toContain("A real perp you drive");
  });

  it("tells the gacha story: pull, bet, win", () => {
    expect(landingHtml).toContain("Crack a crate.");
    expect(landingHtml).toContain("Bet the race.");
    expect(landingHtml).toMatch(/01 \/ PULL/);
    expect(landingHtml).toMatch(/02 \/ BET/);
    expect(landingHtml).toMatch(/03 \/ WIN/);
    expect(landingHtml).toContain("CARS</small> 20+");
    expect(landingHtml).toContain("pari-mutuel");
    expect(landingHtml).not.toContain("Rev the engine");
    expect(landingHtml).toContain("Launch Slopwheels");
    expect(landingHtml).not.toContain("Launch Perps Rider");
  });

  it("wears the Slopwheels brand everywhere the shell shows a name", () => {
    expect(landingHtml).toContain("<title>Slopwheels");
    expect(landingHtml).toContain("assets/brands/slopwheels-alpha.png");
    expect(landingHtml).not.toContain("PERPS</span>");
    const manifest = JSON.parse(manifestText);
    expect(manifest.name).toBe("Slopwheels");
    expect(manifest.short_name).toBe("Slopwheels");
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

  it("keeps the crate cinematic importable by the landing bundle", () => {
    expect(crateCinematicSrc).not.toContain('from "three"');
    expect(crateCinematicSrc).not.toContain('"../main"');
    expect(crateCinematicSrc).not.toContain('"./cratebox"');
  });

  it("lets any visitor crack one open with the shared cinematic, no game bundle", () => {
    expect(landingHtml).toContain("data-demo-crate");
    expect(landingHtml).toContain('id="crack"');
    expect(landingHtml).toContain("Crack one open.");
    // Same isolation guard as the cinematic: the demo module must never drag three/game code in.
    expect(demoCrateSrc).not.toContain('from "three"');
    expect(demoCrateSrc).not.toContain('"../main"');
  });

  it("contains decorative poster overflow within the hero artwork", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(stylesheet).toMatch(/\.hero-poster \{[^}]*overflow: clip;/);
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

  it("renders the how-it-works steps as poster-only stills without tutorial wiring", () => {
    const howSection = landingHtml.slice(landingHtml.indexOf('id="how"'), landingHtml.indexOf('id="strip"'));
    const videos = howSection.match(/<video\b[\s\S]*?<\/video>/g) ?? [];

    expect(videos).toHaveLength(3);
    for (const video of videos) {
      expect(video).not.toContain("data-tutorial-video");
      expect(video).not.toContain("<source");
      expect(video).not.toContain("autoplay");
      expect(video).toMatch(/<video[^>]*\bloop\b[^>]*\bmuted\b[^>]*\bplaysinline\b/);
      expect(video).toMatch(/poster="\/assets\/landing\/step-(pull|bet|win)\.webp"/);
      expect(video).toContain('aria-hidden="true"');
    }
    expect(landingHtml).not.toMatch(/<div class="step-media"><img/);
  });

  it("keeps perps as mode 2 with its real numbers", () => {
    expect(landingHtml).toContain('id="mode2"');
    expect(landingHtml).toContain("real perp");
    expect(landingHtml).toContain("10× to 3000×");
    expect(landingHtml).toContain("/tutorial/leverage.webm");
    expect(landingHtml).toContain('href="#mode2"');

    expect(landingHtml.match(/data-tutorial-video/g) ?? []).toHaveLength(2);
    const mode2 = landingHtml.slice(landingHtml.indexOf('id="mode2"'), landingHtml.indexOf('id="built-on"'));
    expect(mode2.match(/data-tutorial-video/g) ?? []).toHaveLength(2);
  });

  it("actively starts tutorial loops when motion is allowed", () => {
    const entry = Object.values(landingScripts)[0] as string;

    expect(entry).toContain('[data-tutorial-video]');
    expect(entry).toContain("video.play().catch");
    expect(entry).toContain("video.pause()");
  });

  it("does not render a manual motion control", () => {
    expect(landingHtml).not.toContain("data-motion-toggle");
    expect(landingHtml).not.toContain('aria-label="Motion"');
  });

  it("has no manual motion control styling", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(stylesheet).not.toContain(".motion-toggle");
  });

  it("uses OS reduced motion and page visibility without persisting a manual preference", () => {
    const entry = Object.values(landingScripts)[0] as string;
    expect(entry).not.toContain("sessionStorage");
    expect(entry).not.toContain("perps-rider:motion-paused");
    expect(entry).not.toContain("data-motion-toggle");
    expect(entry).not.toContain("userPaused");
    expect(entry).not.toContain('type: "user-paused"');
    expect(entry).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(entry).toContain('reduceMotion.addEventListener("change"');
    expect(entry).toContain('addEventListener("visibilitychange"');
    expect(landingHtml).toContain('data-motion-section="mode2"');
    expect(landingHtml).toContain('data-motion-section="technology"');
  });

  it("presents a four-stage animated technology pipeline", () => {
    for (const scene of ["execution", "tote", "settlement", "world"]) {
      expect(landingHtml).toContain(`data-tech-scene="${scene}"`);
    }
    expect(landingHtml.match(/class="tech-scene/g)).toHaveLength(4);
    expect(landingHtml.match(/<svg/g)).toHaveLength(4);
    expect(landingHtml).toContain("Social Open World");
    expect(landingHtml).toContain("Drive the Strip with other traders, show off your garage, and enter shared destinations together.");
    expect(landingHtml).not.toContain("<canvas");
  });

  it("rethemes the tech rack to pulls, pools, settlement, world", () => {
    expect(landingHtml).toContain("EPHEMERAL VRF / PROVABLY FAIR");
    expect(landingHtml).toContain("Pari-mutuel");
    expect(landingHtml).toContain("podium owners get a slice");
    expect(landingHtml).toContain("Settles to the cent.");
    expect(landingHtml).not.toContain("scene-price");
  });

  it("animates the pari-mutuel tote payline while gating on motion", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");

    expect(landingHtml).toContain('data-tech-scene="tote"');
    expect(landingHtml).toContain('<g class="tote-odds"><text x="240" y="30">x21.8</text>');
    expect(stylesheet).toMatch(/\.scene-tote \.tote-payline \{[^}]*animation: tote-pay [^;]* infinite;/);
    expect(stylesheet).toContain("@keyframes tote-pay");
    // The tote payline is a .tech-scene descendant, so the generic gate kills it when paused.
    expect(stylesheet).toMatch(
      /:where\(html\.motion-paused, html:not\(\.tech-motion-active\)\) \.tech-scene \*:not\(\.tech-brand\) \{[^}]*animation: none !important;/,
    );
    expect(stylesheet).not.toContain(".price-quote");
    expect(stylesheet).not.toContain("@keyframes ticker-flip");
    expect(stylesheet).not.toContain("@keyframes live-pulse");
    expect(stylesheet).not.toContain("@keyframes price-scan");
  });

  it("moves both world cars inward with signed travel variables", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");
    const travelFor = (selector: string) => {
      const rule = stylesheet.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1] ?? "";
      return Number(rule.match(/--car-travel:\s*(-?\d+(?:\.\d+)?)px;/)?.[1]);
    };

    expect(travelFor("car-a")).toBeGreaterThan(0);
    expect(travelFor("car-b")).toBeLessThan(0);
    expect(stylesheet).toMatch(
      /@keyframes car-route \{[\s\S]*?translate3d\(var\(--car-travel\), -7px, 0\)/,
    );
    expect(stylesheet).toMatch(/\.car-b \{[^}]*--tech-phase-delay: 1\.2s;/);
    expect(stylesheet).not.toMatch(/\.car-b \{[^}]*animation:[^;}]*\breverse\b/);
  });

  it("shortens both inward car routes at the mobile breakpoint", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");
    const mobileStart = stylesheet.indexOf("@media (max-width: 760px)");
    const mobileEnd = stylesheet.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
    const mobileStyles = stylesheet.slice(mobileStart, mobileEnd);
    const mobileTravelFor = (selector: string) => {
      const rule = mobileStyles.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1] ?? "";
      return Number(rule.match(/--car-travel:\s*(-?\d+(?:\.\d+)?)px;/)?.[1]);
    };

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileEnd).toBeGreaterThan(mobileStart);
    expect(mobileTravelFor("car-a")).toBe(16);
    expect(mobileTravelFor("car-b")).toBe(-16);
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
    for (const hook of ["tote-rows", "rollup-chamber", "settlement-gate", "world-destination"]) {
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

  it("suppresses every hover transform when motion is paused or reduced", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");
    const reducedMotionStart = stylesheet.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    const reducedMotionStyles = stylesheet.slice(reducedMotionStart);
    const ruleFor = (styles: string, selector: string) => {
      const start = styles.indexOf(`${selector} {`);
      expect(start, `missing CSS rule for ${selector}`).toBeGreaterThanOrEqual(0);
      const open = styles.indexOf("{", start);
      return styles.slice(open + 1, styles.indexOf("}", open));
    };

    const transitionContracts = [
      [".launch-button", "transition-property: filter;"],
      [".apk-button", "transition-property: border-color, background;"],
      [".step-media video", "transition-property: filter;"],
      [".stop-grid article::before", "transition-property: opacity;"],
      [".strip-building", "transition: none;"],
      [".strip-building img", "transition-property: filter;"],
    ] as const;
    for (const [selector, declaration] of transitionContracts) {
      expect(ruleFor(stylesheet, `html.motion-paused ${selector}`)).toContain(declaration);
      expect(ruleFor(reducedMotionStyles, selector)).toContain(declaration);
    }

    for (const selector of [
      ".launch-button:hover",
      ".apk-button:hover",
      ".step-card:hover .step-media video",
      ".stop-grid article:hover::before",
    ]) {
      expect(ruleFor(stylesheet, `html.motion-paused ${selector}`)).toContain("transform: none;");
      expect(ruleFor(reducedMotionStyles, selector)).toContain("transform: none;");
    }
    expect(ruleFor(stylesheet, "html.motion-paused .stop-grid article:hover .strip-building img"))
      .toContain("transform: scale(var(--building-render-scale));");
    expect(ruleFor(reducedMotionStyles, ".stop-grid article:hover .strip-building img"))
      .toContain("transform: scale(var(--building-render-scale));");

    expect(ruleFor(stylesheet, "\n.launch-button:hover")).toContain("filter: brightness(1.08);");
    expect(ruleFor(stylesheet, "\n.apk-button:hover")).toContain("border-color: var(--cyan);");
    expect(ruleFor(stylesheet, "\n.step-card:hover .step-media video")).toContain("filter: saturate(1.15)");
    expect(ruleFor(stylesheet, "\n.stop-grid article:hover")).toContain("background:");
    expect(ruleFor(stylesheet, "\n.stop-grid article:hover::before")).toContain("opacity: 0.85;");
    expect(ruleFor(stylesheet, "\n.stop-grid article:hover .strip-building img")).toContain("filter: brightness(1.12)");
  });

  it("keeps skip-link focus positioning functional without transition motion", async () => {
    const nodeFs = "node:fs/promises";
    const { readFile } = await import(nodeFs);
    const stylesheet = await readFile(new URL("./landing.css", import.meta.url), "utf8");
    const reducedMotionStyles = stylesheet.slice(stylesheet.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

    expect(stylesheet).toMatch(/\.skip-link:focus \{[^}]*transform: translateY\(0\);[^}]*\}/);
    expect(stylesheet).toMatch(/html\.motion-paused \.skip-link \{[^}]*transition: none;[^}]*\}/);
    expect(reducedMotionStyles).toMatch(/\.skip-link \{[^}]*transition: none;[^}]*\}/);
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
