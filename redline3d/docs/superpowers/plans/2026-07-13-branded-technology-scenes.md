# Branded Technology Scenes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic technology-card diagrams with a cinematic four-stage pipeline anchored by canonical MagicBlock and Solana logos.

**Architecture:** Local canonical SVG assets provide stable, undistorted brand anchors with no runtime network dependency. Existing inline SVG scenes remain decorative underlays, while CSS transform and opacity keyframes animate data, rails, cars, and pipeline pulses around the logos. The existing global motion state pauses all optional animation.

**Tech Stack:** HTML, SVG, CSS transforms and opacity, Vitest, Vite.

## Global Constraints

- Preserve all existing technology card copy exactly.
- Use the canonical MagicBlock horizontal white logo and canonical Solana gradient mark.
- Store both SVGs locally under `public/assets/brands` and record their official sources.
- Preserve brand geometry, colors, and aspect ratios. Do not skew, outline, redraw, or recolor either mark.
- Do not apply filters or shadows to the Solana mark.
- Decorative scenes remain `aria-hidden="true"` and logo images use empty alt text inside those scenes.
- Repeating motion uses transform and opacity only.
- Global Motion Off, reduced motion, document visibility, and technology-section visibility pause every optional scene animation.
- Preserve 4-column desktop, 2-column tablet, and 1-column mobile layouts.
- Do not add canvas, Three.js, external runtime assets, or production dependencies.
- Use no em dashes in copy or documentation.

---

### Task 1: Canonical Local Brand Assets

**Files:**
- Create: `redline3d/public/assets/brands/magicblock-logo.svg`
- Create: `redline3d/public/assets/brands/solana-mark.svg`
- Create: `redline3d/public/assets/brands/README.md`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Produces: `/assets/brands/magicblock-logo.svg` with viewBox `0 0 162 32`.
- Produces: `/assets/brands/solana-mark.svg` with viewBox `0 0 101 88`.
- Produces: canonical-source documentation consumed by Task 2 and future brand updates.

- [ ] **Step 1: Write the failing brand asset contract**

Add near the existing raw imports:

```ts
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
```

Add this test:

```ts
it("ships canonical local MagicBlock and Solana marks", () => {
  const magicblock = brandAssets["../../public/assets/brands/magicblock-logo.svg"] as string | undefined;
  const solana = brandAssets["../../public/assets/brands/solana-mark.svg"] as string | undefined;
  const sources = Object.values(brandDocs)[0] as string | undefined;

  expect(Object.keys(brandAssets)).toHaveLength(2);
  expect(magicblock).toContain('viewBox="0 0 162 32"');
  expect(magicblock).toContain('fill="white"');
  expect(solana).toContain('viewBox="0 0 101 88"');
  expect(solana).toContain('stop-color="#9945FF"');
  expect(solana).toContain('stop-color="#19FB9B"');
  expect(sources).toContain("https://www.magicblock.xyz/");
  expect(sources).toContain("https://solana.com/branding");
  expect(sources).toContain("Retrieved: 2026-07-13");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run `cd redline3d && npx vitest run src/landing/landing-shell.test.ts`.

Expected: FAIL because the brand asset glob is empty.

- [ ] **Step 3: Add exact canonical SVG contents**

Use `apply_patch` to add the verbatim response bodies from:

```text
https://cdn.prod.website-files.com/67dd3f471f62a240dd544dd8/682efe2b89d00ecb838fa333_Frame%2085.svg
https://solana.com/src/img/branding/solanaLogoMark.svg
```

Do not minify, recolor, rename internal IDs, merge paths, or alter viewBoxes. Confirm the MagicBlock file begins with:

```xml
<svg width="162" height="32" viewBox="0 0 162 32" fill="none" xmlns="http://www.w3.org/2000/svg">
```

Confirm the Solana file begins with:

```xml
<svg width="101" height="88" viewBox="0 0 101 88" fill="none" xmlns="http://www.w3.org/2000/svg">
```

- [ ] **Step 4: Document sources and usage**

Create `README.md`:

```md
# Landing Brand Assets

Retrieved: 2026-07-13

- `magicblock-logo.svg`: canonical horizontal white logo from the [official MagicBlock website](https://www.magicblock.xyz/). Direct source: `https://cdn.prod.website-files.com/67dd3f471f62a240dd544dd8/682efe2b89d00ecb838fa333_Frame%2085.svg`.
- `solana-mark.svg`: canonical gradient logomark from the [official Solana brand kit](https://solana.com/branding). Direct source: `https://solana.com/src/img/branding/solanaLogoMark.svg`.

Keep both assets unmodified. Preserve aspect ratio and clear visual space. Do not recolor, skew, outline, or redraw them. Do not apply filters or shadows to the Solana mark.
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd redline3d
npx vitest run src/landing/landing-shell.test.ts
npm run build
```

Expected: focused test PASS and production build exits 0.

Commit:

```bash
git add redline3d/public/assets/brands redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: add canonical technology brand assets"
```

---

### Task 2: Cinematic Branded Technology Pipeline

**Files:**
- Modify: `redline3d/index.html`
- Modify: `redline3d/src/landing/landing.css`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Consumes: `/assets/brands/magicblock-logo.svg` and `/assets/brands/solana-mark.svg` from Task 1.
- Consumes: `.tech-motion-active`, `.motion-paused`, and `--tech-delay` from the existing motion controller.
- Produces: `[data-tech-brand="magicblock|solana"]`, `.pipeline-pulse`, `.price-ticker`, `.rollup-chamber`, `.settlement-gate`, and `.world-destination`.

- [ ] **Step 1: Write the failing cinematic scene contract**

Add this test:

```ts
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
  expect(stylesheet).not.toMatch(/@keyframes[^}]*background-position/);
  expect(landingHtml).not.toContain("<canvas");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run `cd redline3d && npx vitest run src/landing/landing-shell.test.ts`.

Expected: FAIL because the canonical logo hooks and cinematic elements do not exist.

- [ ] **Step 3: Upgrade the four scene structures**

Keep one inline decorative SVG per card. Preserve every card number, heading, provider, and description. Add these exact anchor structures inside the corresponding scenes:

```html
<div class="price-ticker"><b>$142.87</b><small>+4.26%</small><i>LIVE</i></div>

<div class="rollup-chamber">
  <span class="rollup-pressure"></span>
  <img class="tech-brand tech-brand-magicblock" data-tech-brand="magicblock" src="/assets/brands/magicblock-logo.svg" width="162" height="32" alt="" />
</div>
<i class="tx-shard tx-shard-a"></i><i class="tx-shard tx-shard-b"></i><i class="tx-shard tx-shard-c"></i><i class="confirmed-bolt"></i>

<div class="settlement-gate">
  <span class="settlement-rail rail-a"></span><span class="settlement-rail rail-b"></span><span class="settlement-rail rail-c"></span>
  <img class="tech-brand tech-brand-solana" data-tech-brand="solana" src="/assets/brands/solana-mark.svg" width="101" height="88" alt="" />
  <i class="settlement-seal"></i>
</div>

<div class="world-destination"><i></i><b>THE STRIP</b></div>
<span class="driver driver-a"></span><span class="driver driver-b"></span><span class="driver driver-c"></span>
```

Add a single `<i class="pipeline-pulse" aria-hidden="true"></i>` as the first child of `.tech-grid` so it travels across the desktop connector.

- [ ] **Step 4: Replace generic motion with three-beat cinematic sequences**

Add stable logo sizing and scene layout:

```css
.tech-brand { position: relative; z-index: 4; display: block; object-fit: contain; }
.tech-brand-magicblock { width: min(78%, 162px); height: auto; }
.tech-brand-solana { width: 62px; height: auto; filter: none; }
.rollup-chamber,.settlement-gate { position: absolute; inset: 24px 18px 20px; display: grid; place-items: center; }
.pipeline-pulse { position: absolute; z-index: 3; top: 102px; left: 8%; width: 52px; height: 5px; border-radius: 999px; background: linear-gradient(90deg,transparent,#fff,var(--cyan),transparent); animation: pipeline-travel 7.2s cubic-bezier(.2,.7,.2,1) infinite; }
```

Implement only transform and opacity animation for the repeated motion:

```css
@keyframes tx-ingest { 0%,12%{transform:translate3d(-72px,0,0) scaleX(1);opacity:0} 28%{opacity:1} 58%{transform:translate3d(0,0,0) scaleX(.35);opacity:1} 70%,100%{transform:translate3d(12px,0,0) scaleX(.08);opacity:0} }
@keyframes settlement-converge { 0%,18%{transform:translate3d(var(--rail-x),var(--rail-y),0) rotate(var(--rail-rotate)) scaleX(.3);opacity:0} 48%,72%{transform:translate3d(0,0,0) rotate(var(--rail-rotate)) scaleX(1);opacity:1} 88%,100%{transform:translate3d(0,0,0) rotate(var(--rail-rotate)) scaleX(.7);opacity:.25} }
@keyframes world-arrival { 0%,14%{transform:translate3d(var(--driver-x),24px,0) scale(.65);opacity:0} 52%,76%{transform:translate3d(0,0,0) scale(1);opacity:1} 100%{transform:translate3d(0,-8px,0) scale(.82);opacity:.35} }
@keyframes pipeline-travel { 0%,8%{transform:translate3d(0,0,0) scaleX(.2);opacity:0} 18%{opacity:1} 84%{transform:translate3d(calc(84vw - 110px),0,0) scaleX(1);opacity:1} 94%,100%{transform:translate3d(calc(84vw - 80px),0,0) scaleX(.2);opacity:0} }
```

Use these exact animation assignments and supporting keyframes. Add `class="city-windows"` to a `<g>` containing at least six window `<rect>` elements in the World SVG.

```css
.price-ticker b { display:block; transform-origin:center; animation:ticker-flip 3.2s steps(1,end) infinite; }
.rollup-pressure { position:absolute; inset:18px 0; border:1px solid currentColor; border-radius:16px; animation:chamber-pressure 2.8s ease-in-out infinite; }
.tx-shard { position:absolute; left:12px; width:34px; height:4px; background:currentColor; animation:tx-ingest 2.8s cubic-bezier(.2,.8,.2,1) infinite; }
.tx-shard-a { top:38px; }.tx-shard-b { --tech-phase-delay:.16s; top:64px; }.tx-shard-c { --tech-phase-delay:.32s; top:90px; }
.confirmed-bolt { position:absolute; top:61px; right:4px; width:42px; height:5px; background:currentColor; animation:confirmed-fire 2.8s ease-out infinite; }
.settlement-rail { position:absolute; width:74px; height:2px; background:currentColor; animation:settlement-converge 3.2s ease-in-out infinite; }
.rail-a { --rail-x:-62px; --rail-y:-34px; --rail-rotate:28deg; }.rail-b { --rail-x:62px; --rail-y:-34px; --rail-rotate:-28deg; }.rail-c { --rail-x:0px; --rail-y:52px; --rail-rotate:0deg; }
.settlement-seal { position:absolute; right:22px; bottom:9px; width:18px; height:18px; border:2px solid currentColor; border-radius:50%; animation:seal-resolve 3.2s ease-in-out infinite; }
.driver { position:absolute; bottom:18px; width:9px; height:9px; border-radius:50%; background:currentColor; animation:world-arrival 3.6s ease-in-out infinite; }
.driver-a { --driver-x:-74px; left:32%; }.driver-b { --driver-x:74px; --tech-phase-delay:.22s; left:50%; }.driver-c { --driver-x:-42px; --tech-phase-delay:.44s; left:68%; }
.world-destination i { display:block; width:44px; height:44px; border:1px solid currentColor; border-radius:50%; animation:destination-pulse 3.6s ease-out infinite; }
.city-windows rect { transform-box:fill-box; transform-origin:center; animation:window-wake 3.6s steps(2,end) infinite; }
@keyframes ticker-flip { 0%,42%{transform:translate3d(0,0,0);opacity:1} 48%{transform:translate3d(0,-8px,0);opacity:0} 54%{transform:translate3d(0,8px,0);opacity:0} 60%,100%{transform:translate3d(0,0,0);opacity:1} }
@keyframes chamber-pressure { 0%,18%{transform:scaleX(1.12);opacity:.12} 52%,72%{transform:scaleX(.92);opacity:.75} 100%{transform:scaleX(1.04);opacity:.18} }
@keyframes confirmed-fire { 0%,62%{transform:translate3d(-20px,0,0) scaleX(.1);opacity:0} 74%{opacity:1} 92%,100%{transform:translate3d(44px,0,0) scaleX(1);opacity:0} }
@keyframes seal-resolve { 0%,48%{transform:scale(.25) rotate(-90deg);opacity:0} 68%,86%{transform:scale(1) rotate(0);opacity:1} 100%{transform:scale(.82);opacity:.35} }
@keyframes destination-pulse { 0%,44%{transform:scale(.45);opacity:0} 62%{opacity:.9} 100%{transform:scale(1.7);opacity:0} }
@keyframes window-wake { 0%,38%{transform:scaleY(.15);opacity:.12} 54%,100%{transform:scaleY(1);opacity:.86} }
```

Keep the logo images themselves free of animation declarations.

At `max-width: 1100px`, hide `.pipeline-pulse` with the desktop connector. At `max-width: 760px`, reduce secondary particles and travel distances without hiding the two brand marks.

- [ ] **Step 5: Confirm paused compositions**

Ensure the price trace and ticker, MagicBlock chamber and logo, Solana gate and mark, and city destination and drivers are all visible without animation. Existing selectors must continue to match every animated descendant:

```css
html.motion-paused .tech-scene *,
html:not(.tech-motion-active) .tech-scene * { animation-play-state: paused !important; }
```

Include `.pipeline-pulse` in the paused selector because it is a `.tech-grid` child rather than a `.tech-scene` descendant.

- [ ] **Step 6: Verify desktop and mobile behavior**

Run focused tests and the production build, then inspect `#built-on` at desktop and mobile widths. Record:

- both logo assets load with natural dimensions,
- four scenes are visible,
- desktop cards have no clipped marks,
- mobile cards have no horizontal overflow,
- Motion Off freezes logo-adjacent effects and the pipeline pulse,
- the console has no errors.

- [ ] **Step 7: Commit**

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: rebuild technology scenes around brand marks"
```
