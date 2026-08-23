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

const entry = () => Object.values(landingScripts)[0] as string;
// CSS is processed (not raw) through Vite's ?raw in this test env, so read the source file directly.
async function readLandingCss(): Promise<string> {
  const nodeFs = "node:fs/promises";
  const { readFile } = await import(nodeFs);
  return readFile(new URL("./landing.css", import.meta.url), "utf8");
}

describe("Slopwheels landing shell — Midnight Drop", () => {
  it("is the root landing page, wired to the Vite entry and the game", () => {
    expect(landingHtml).toContain("data-landing-page");
    expect(landingHtml).toContain('href="/play/"');
    expect(landingHtml).toContain('/src/landing/landing.css');
    expect(landingHtml).toContain('/src/landing/main.ts');
    expect(landingHtml).not.toContain('/src/main.ts'); // the game entry never ships on the landing page
  });

  it("wears the Slopwheels brand — the shelved $SLOP token never appears", () => {
    expect(landingHtml).toContain("<title>Slopwheels");
    expect(landingHtml).not.toContain("$SLOP"); // token shelved — no ticker anywhere
    expect(landingHtml).not.toMatch(/token/i); // and no token talk in any spelling
    expect(landingHtml).not.toContain("SLOBS");
    expect(landingHtml).not.toContain("SLOPS");
    expect(landingHtml).toContain('property="og:image" content="/assets/landing/og-slopwheels.png"');
    const manifest = JSON.parse(manifestText);
    expect(manifest.name).toBe("Slopwheels");
    expect(manifest.short_name).toBe("Slopwheels");
  });

  it("shows the slime-face mark alone — no SLOPWHEELS wordmark in the lockups", () => {
    const header = landingHtml.slice(landingHtml.indexOf("<header"), landingHtml.indexOf("</header>"));
    expect(header).toContain("/assets/brands/slopface.png");
    expect(landingHtml).not.toContain("SLOPWHEELS"); // wordmark text dropped from header + footer
    expect(landingHtml).not.toContain('class="wm"');
  });

  it("labels the drop 'Soon' and softens the 'now' claims to match", () => {
    expect(landingHtml).toContain("Season 1 · The Slop Drop (Soon)");
    expect(landingHtml).toContain("Season 1 is dropping soon.");
    expect(landingHtml).not.toContain("pullable right now");
  });

  it("lays the sections out in the approved order", () => {
    const order = [
      'class="hero"',              // hero
      'id="drop"',                 // collect story
      'id="crack"',                // live demo crate
      "How the drop works",        // how the drop works
      'id="why"',                  // why collect
      'id="how"',                  // pull / bet / win
      'id="garage"',               // card gallery
      'id="lobby"',                // lobby
      'id="perps"',                // perps rider
      "Arcade feel. Real rails.",  // built on
      "pulling next?",             // final CTA
      'class="foot"',              // footer
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = landingHtml.indexOf(marker);
      expect(at, `section marker not found: ${marker}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("carries the verbatim story copy for every section", () => {
    expect(landingHtml).toContain("Crack crates.");
    expect(landingHtml).toContain("Collect wheels.");
    expect(landingHtml).toContain("Win the pot.");
    expect(landingHtml).toContain("Not all crates hit the same.");
    expect(landingHtml).toContain("Three moves, one loop");
    expect(landingHtml).toContain("The garage");
    expect(landingHtml).toContain("The lobby is a place");
    expect(landingHtml).toContain("Perps Rider");
    expect(landingHtml).toContain("There's a real perp");
    expect(landingHtml).toContain("five rarity tiers"); // rarity survives in "How the drop works"
  });

  it("reserves 'slop' for the brand — collectibles are 'wheels', the token is gone", () => {
    // hero green line + earn headline now say "wheels"
    expect(landingHtml).toContain("<span>Collect wheels.</span>");
    expect(landingHtml).toContain("Collect the wheels.");
    // no collectible-sense "slop" survives
    expect(landingHtml).not.toContain("Collect slop");
    expect(landingHtml).not.toContain("Collect the slop");
    expect(landingHtml).not.toContain("Built for the slop");
    expect(landingHtml).not.toMatch(/alt="[^"]*slopface[^"]*"/); // alt text de-slopped (the /brands/slopface.png asset path stays)
    // brand and event name keep their exact spellings; the shelved token never appears
    expect(landingHtml).toContain("Slopwheels");
    expect(landingHtml).toContain("The Slop Drop");
    expect(landingHtml).not.toContain("$SLOP");
  });

  it("explains the product in plain English — no unexplained jargon", () => {
    expect(landingHtml).toContain("Slopwheels is a racing game where you open crates and collect cartoon cars.");
    expect(landingHtml).toContain("Everyone's bets go into <b>one shared pot</b>");
    expect(landingHtml).not.toContain("gacha");
    expect(landingHtml).not.toContain("pari-mutuel");
    // verified facts survive the rewrite
    expect(landingHtml).toContain("five rarity tiers");
    expect(landingHtml).toContain("finishes on the podium");
  });

  it("sorts the card gallery ascending — commons first, legendaries last", () => {
    const gridAt = landingHtml.indexOf('class="grid"');
    const gallery = landingHtml.slice(gridAt, landingHtml.indexOf("</section>", gridAt));
    const rank: Record<string, number> = { "t-common": 1, "t-uncommon": 2, "t-rare": 3, "t-epic": 4, "t-legend": 5 };
    const order = [...gallery.matchAll(/gcard (t-common|t-uncommon|t-rare|t-epic|t-legend)/g)].map((m) => rank[m[1]]);
    expect(order).toHaveLength(12);
    expect(order[0]).toBe(1); // first card is Common
    expect(order[order.length - 1]).toBe(5); // last card is Legendary
    expect(order).toEqual([...order].sort((a, b) => a - b)); // non-decreasing rarity
  });

  it("removes the rarity-ladder / odds-shrine section entirely", async () => {
    expect(landingHtml).not.toContain("The rarity ladder");
    expect(landingHtml).not.toContain("Five tiers. One dream pull.");
    expect(landingHtml).not.toContain("The rarest cars aren't for sale. They're pulled.");
    expect(landingHtml).not.toContain('class="ladder"');
    expect(landingHtml).not.toContain('class="shrine"');
    expect(landingHtml).not.toContain('id="rarities"');
    expect(landingHtml).not.toContain('href="#rarities"'); // no dead nav/footer anchor
    const css = await readLandingCss();
    expect(css).not.toContain(".shrine");
    expect(css).not.toContain(".ladder");
  });

  it("removes the $SLOP teaser panel entirely — no orphan section or styles", async () => {
    expect(landingHtml).not.toContain("What is <span");
    expect(landingHtml).not.toContain('class="slops');
    expect(landingHtml).not.toContain("first in line");
    const css = await readLandingCss();
    expect(css).not.toContain(".slops");
    expect(css).not.toContain(".tk");
  });

  it("labels the highway section 'Perps' and the gallery link 'Garage' — no 'Mode 2'", () => {
    expect(landingHtml).not.toContain("Mode 2");
    expect(landingHtml).not.toContain('id="mode2"');
    expect(landingHtml).not.toContain('href="#mode2"');
    expect(landingHtml).not.toContain("My Garage");
    expect(landingHtml).toContain('id="perps"');
    expect(landingHtml).toContain('href="#perps"');
    expect(landingHtml).toContain('<a class="pill" href="#perps">Perps</a>');
    expect(landingHtml).toContain('<a class="pill" href="#garage">Garage</a>');
    expect(landingHtml).toContain("Perps · The highway");
    expect(landingHtml).toContain("Perps Rider"); // big section title stays
  });

  it("keeps the verbatim risk note and the 10× to 3000× line", () => {
    expect(landingHtml).toContain(
      "<strong>REAL SOL INVOLVES REAL RISK.</strong> You can lose your play amount. Only play with what you can afford to lose.",
    );
    expect(landingHtml).toContain("10× to 3000×");
  });

  it("builds the hero as five rarity-framed 3D trading cards", () => {
    expect(landingHtml.match(/<model-viewer/g) ?? []).toHaveLength(5);
    expect(landingHtml.match(/\/assets\/hero3d\//g) ?? []).toHaveLength(5);
    // real tiers per src/main.ts + src/core/rarity.ts: clown-car legendary, delorean epic, vaporwave rare, dragon/banana common
    expect(landingHtml).toContain('src="/assets/hero3d/clown-car.glb"');       // legendary center, eager
    expect(landingHtml).toContain('class="hcard t-legend pos-2"');
    expect(landingHtml).toContain('<b class="hcard-name">Clown Car</b><span class="hcard-tier">Legendary</span>');
    expect(landingHtml).toContain('data-mvsrc="/assets/hero3d/delorean.glb"');
    expect(landingHtml).toContain('data-mvsrc="/assets/hero3d/vaporwave.glb"');
    expect(landingHtml).toContain('data-mvsrc="/assets/hero3d/dragon.glb"');
    expect(landingHtml).toContain('data-mvsrc="/assets/hero3d/banana.glb"');
    // one eager src (center) + four data-mvsrc (flanks, desktop-only) = one GLB fetched on phones
    expect(landingHtml.match(/data-mvsrc="/g) ?? []).toHaveLength(4);
    expect(landingHtml.match(/<model-viewer[^>]*\ssrc="/g) ?? []).toHaveLength(1);
  });

  it("serves the 3D stack self-hosted — never a CDN, never the mock GLBs", () => {
    expect(landingHtml).toContain('<script type="module" src="/vendor/model-viewer.min.js"></script>');
    for (const cdn of ["unpkg", "jsdelivr", "ajax.googleapis", "modelviewer.dev", "@google/model-viewer"]) {
      expect(landingHtml).not.toContain(cdn);
    }
    expect(landingHtml).not.toContain("/mocks/hero/");
    // model-viewer stays an external element, never an npm import that would drag three into the bundle
    expect(entry()).not.toContain("@google/model-viewer");
    expect(entry()).not.toContain('from "three"');
    // Draco decoder is configured on the constructor after the element defines itself
    expect(entry()).toContain('whenDefined("model-viewer")');
    expect(entry()).toContain("dracoDecoderLocation");
    expect(entry()).toContain('"/vendor/draco/"');
    // phones fetch only the center GLB: flanks promote data-mvsrc → src on desktop
    expect(entry()).toContain('matchMedia("(min-width: 768px)")');
    expect(entry()).toContain("data-mvsrc");
  });

  it("governs the lobby + perps videos through motion-state videoSections", () => {
    expect(landingHtml).toContain('data-motion-section="lobby"');
    expect(landingHtml).toContain('data-motion-section="perps"');

    const lobby = landingHtml.slice(landingHtml.indexOf('id="lobby"'), landingHtml.indexOf('id="perps"'));
    const perps = landingHtml.slice(landingHtml.indexOf('id="perps"'), landingHtml.indexOf('class="built"'));
    const videosIn = (html: string) => html.match(/<video\b[\s\S]*?<\/video>/g) ?? [];

    expect(videosIn(lobby)).toHaveLength(1);
    expect(videosIn(perps)).toHaveLength(3);
    for (const video of [...videosIn(lobby), ...videosIn(perps)]) {
      expect(video).toContain('preload="none"');
      expect(video).toMatch(/poster="\/tutorial\/[^"]+\.webp"/);
      expect(video).toContain("data-tutorial-video");
      expect(video).toMatch(/<video[^>]*\bmuted\b/);
      expect(video).toMatch(/<video[^>]*\bloop\b/);
      expect(video).toMatch(/<video[^>]*\bplaysinline\b/);
    }
    expect(landingHtml.match(/data-tutorial-video/g) ?? []).toHaveLength(4);

    // the runtime plays/pauses these on view, gated by videoSections + global motion
    const src = entry();
    expect(src).toContain("videoPlaybackEnabled");
    expect(src).toContain("[data-motion-section]");
    expect(src).toContain("[data-tutorial-video]");
    expect(src).toContain("video.play()");
    expect(src).toContain("video.pause()");
  });

  it("wires the live 'Crack one open' demo exactly once", () => {
    expect(landingHtml.match(/data-demo-crate/g) ?? []).toHaveLength(1);
    expect(landingHtml.match(/data-demo-open/g) ?? []).toHaveLength(1);
    expect(landingHtml).toContain("Crack one");
    expect(landingHtml).toContain("open.");
    expect(landingHtml).toContain('id="crack"');
  });

  it("uses OS reduced motion + page visibility without a manual control", () => {
    const src = entry();
    expect(src).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(src).toContain('reduceMotion.addEventListener("change"');
    expect(src).toContain('addEventListener("visibilitychange"');
    expect(src).not.toContain("sessionStorage");
    expect(src).not.toContain("data-motion-toggle");
    expect(landingHtml).not.toContain("data-motion-toggle");
    expect(landingHtml).not.toContain("<canvas");
  });

  it("keeps the how-it-works loop as poster stills (no video wiring in that band)", () => {
    const how = landingHtml.slice(landingHtml.indexOf('id="how"'), landingHtml.indexOf('id="garage"'));
    expect(how).not.toContain("<video");
    for (const still of ["step-pull", "step-bet", "step-win"]) {
      expect(how).toContain(`/assets/landing/${still}.webp`);
    }
  });

  it("keeps the landing bundle isolated from three and the game", () => {
    expect(Object.keys(landingScripts)).toHaveLength(1);
    expect(Object.keys(landingStyles)).toHaveLength(1);
    const src = entry();
    expect(src).not.toContain("@capacitor/core");
    expect(src).not.toContain("location.replace");
    expect(src).not.toContain('from "three"');
    expect(src).not.toContain('from "../main"');
    expect(src).not.toContain('"./cratebox"');
  });

  it("keeps the crate cinematic + demo importable by the landing bundle", () => {
    for (const guarded of [crateCinematicSrc, demoCrateSrc]) {
      expect(guarded).not.toContain('from "three"');
      expect(guarded).not.toContain('"../main"');
      expect(guarded).not.toContain('"./cratebox"');
    }
  });

  it("keeps WebGLRenderer out of the built landing chunk (scoped to assets/landing-*.js)", async () => {
    // /vendor/model-viewer.min.js DOES contain WebGLRenderer but is copied verbatim to dist/vendor/ —
    // NOT into the landing JS chunk. Scope the guard to the built entry chunk, not all of dist. Runs only
    // after `npm run build`; a fresh checkout with no dist skips it (the source-import guards above hold).
    const nodeFs = "node:fs";
    const nodeUrl = "node:url";
    const { existsSync, readdirSync, readFileSync } = await import(nodeFs);
    const { fileURLToPath } = await import(nodeUrl);
    const distAssets = fileURLToPath(new URL("../../dist/assets/", import.meta.url));
    if (!existsSync(distAssets)) return;
    const landingChunks = readdirSync(distAssets).filter((f: string) => /^landing-.*\.js$/.test(f));
    expect(landingChunks.length).toBeGreaterThan(0);
    for (const chunk of landingChunks) {
      expect(readFileSync(distAssets + chunk, "utf8")).not.toContain("WebGLRenderer");
    }
  });

  it("keeps the game shell at play and starts installed experiences there", () => {
    expect(Object.keys(gamePages)).toHaveLength(1);
    const gameHtml = Object.values(gamePages)[0] as string | undefined;
    expect(gameHtml).toContain('/src/main.ts');
    expect(JSON.parse(manifestText).start_url).toBe("/play/");
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

  it("keeps the --brand token and anchors the built-on marks", async () => {
    expect(await readLandingCss()).toContain("--brand: #c0f030");
    expect(landingHtml).toContain('src="/assets/brands/solana-mark.svg"');
    expect(landingHtml).toContain('src="/assets/brands/magicblock-logo.svg"');
  });

  it("ships canonical local MagicBlock and Solana marks", async () => {
    const nodeCrypto = "node:crypto";
    const { createHash } = await import(nodeCrypto);
    const magicblock = brandAssets["../../public/assets/brands/magicblock-logo.svg"] as string | undefined;
    const solana = brandAssets["../../public/assets/brands/solana-mark.svg"] as string | undefined;
    const sources = Object.values(brandDocs)[0] as string | undefined;

    expect(magicblock).toContain('viewBox="0 0 162 32"');
    expect(solana).toContain('viewBox="0 0 101 88"');
    expect(createHash("sha256").update(magicblock ?? "").digest("hex")).toBe(
      "adb0d0abd1ba7161d784c222d7a4821667e6b7b343e9810ceed39736fc03017c",
    );
    expect(createHash("sha256").update(solana ?? "").digest("hex")).toBe(
      "3d3401109aa061dec40a8659f1847817a8e647f98de1e65e76e86a95bbe1f08a",
    );
    expect(sources).toContain("https://www.magicblock.xyz/");
    expect(sources).toContain("https://solana.com/branding");
  });
});
