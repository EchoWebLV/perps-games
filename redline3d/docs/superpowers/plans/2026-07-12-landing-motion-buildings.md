# Landing Motion and Buildings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static tutorial images with resilient video loops, render four distinct Strip buildings, and add a reactive Neon Freeway Mirage background to the Perps Rider landing page.

**Architecture:** Keep the landing bundle dependency-free. Semantic hooks and fallback media live in `index.html`, all rendering and animation live in `landing.css`, and `landing/main.ts` only adapts reduced-motion, pointer, and orientation input into CSS custom properties through `requestAnimationFrame`.

**Tech Stack:** HTML5 video, CSS custom properties and keyframes, TypeScript DOM APIs, Vitest raw-source contract tests, Vite.

## Global Constraints

- Do not add Canvas, WebGL, Three.js, Capacitor, or a media-player dependency to the landing bundle.
- Use the existing tutorial WebM, MP4, and WebP files. Do not create or re-encode media.
- Tutorial videos have no audio and expose no controls.
- All new visuals are decorative and must use `aria-hidden="true"` or an equivalent empty accessible representation.
- `prefers-reduced-motion: reduce` disables autoplay, input parallax, ambient keyframes, and nonessential hover movement.
- Preserve the game route, landing copy, calls to action, keyboard focus styles, and existing responsive breakpoints.
- Use no em dashes in copy or documentation.

## File Structure

- Modify `redline3d/index.html`: tutorial `<video>` markup, four building illustration trees, and the global motion-background layers.
- Modify `redline3d/src/landing/landing.css`: video media rules, building renderer, motion field, responsive behavior, and reduced-motion overrides.
- Modify `redline3d/src/landing/main.ts`: reduced-motion video handling plus frame-coalesced pointer and device-orientation input.
- Modify `redline3d/src/landing/landing-shell.test.ts`: raw-source contracts for all three visual systems and dependency isolation.

---

### Task 1: Native Tutorial Video Loops

**Files:**
- Modify: `redline3d/src/landing/landing-shell.test.ts`
- Modify: `redline3d/index.html:79-92`
- Modify: `redline3d/src/landing/landing.css:616-641,1168-1190`
- Modify: `redline3d/src/landing/main.ts:5-8`

**Interfaces:**
- Consumes: Existing `/tutorial/{market-side,leverage,cash-out}.{webm,mp4,webp}` assets and the current `reducedMotion` boolean.
- Produces: Three `[data-tutorial-video]` elements whose playback can be paused by the landing script and styled by `.step-media video`.

- [ ] **Step 1: Write the failing tutorial-video contract test**

Add this test to `landing-shell.test.ts`:

```ts
it("uses resilient native video loops for every tutorial step", () => {
  const videos = landingHtml.match(/<video\b[\s\S]*?<\/video>/g) ?? [];

  expect(videos).toHaveLength(3);
  for (const video of videos) {
    expect(video).toContain("data-tutorial-video");
    expect(video).toMatch(/autoplay[^>]*loop[^>]*muted[^>]*playsinline|autoplay[^>]*muted[^>]*loop[^>]*playsinline/);
    expect(video).toMatch(/poster="\/tutorial\/(market-side|leverage|cash-out)\.webp"/);
    expect(video).toContain('type="video/webm"');
    expect(video).toContain('type="video/mp4"');
    expect(video).toContain('aria-hidden="true"');
  }
  expect(landingHtml).not.toMatch(/<div class="step-media"><img/);
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts
```

Expected: FAIL because the How It Works cards still contain three `<img>` elements and no `<video>` elements.

- [ ] **Step 3: Replace each tutorial image with native fallback video markup**

Use this structure for each card, substituting `leverage` and `cash-out` for the other two cards:

```html
<div class="step-media">
  <video autoplay loop muted playsinline preload="metadata" poster="/tutorial/market-side.webp" data-tutorial-video aria-hidden="true">
    <source src="/tutorial/market-side.webm" type="video/webm" />
    <source src="/tutorial/market-side.mp4" type="video/mp4" />
  </video>
</div>
```

- [ ] **Step 4: Update media styling and reduced-motion playback**

Change the image selectors in `landing.css` to video selectors:

```css
.step-media video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: saturate(0.9) contrast(1.05);
  transition: filter 0.3s ease, transform 0.5s ease;
}

.step-card:hover .step-media video {
  filter: saturate(1.15) contrast(1.05);
  transform: scale(1.025);
}
```

Immediately after the `reducedMotion` declaration in `landing/main.ts`, add:

```ts
const tutorialVideos = document.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]");

if (reducedMotion) {
  tutorialVideos.forEach((video) => {
    video.autoplay = false;
    video.pause();
  });
}
```

Change the reduced-motion hover selector from `.step-media img` to `.step-media video`.

- [ ] **Step 5: Run the landing test and build**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts && npm run build
```

Expected: landing tests PASS and the TypeScript/Vite production build exits with code 0.

- [ ] **Step 6: Commit the video slice**

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/main.ts redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: play tutorial video loops on landing"
```

---

### Task 2: Four Distinct Strip Buildings

**Files:**
- Modify: `redline3d/src/landing/landing-shell.test.ts`
- Modify: `redline3d/index.html:102-107`
- Modify: `redline3d/src/landing/landing.css:695-749,951-961,1118-1135,1168-1190`

**Interfaces:**
- Consumes: Existing `.stop-grid` responsive grid, `--green`, `--cyan`, `--amber`, and `--magenta` tokens.
- Produces: Four `.strip-building[data-building]` illustrations with values `track`, `garage`, `upgrades`, and `crates`; each contains `.building-shell` plus building-specific façade elements.

- [ ] **Step 1: Write the failing building contract test**

Add this test:

```ts
it("renders four distinct decorative buildings on the Strip", () => {
  for (const building of ["track", "garage", "upgrades", "crates"]) {
    expect(landingHtml).toContain(`class="strip-building building-${building}"`);
    expect(landingHtml).toContain(`data-building="${building}"`);
  }
  expect(landingHtml.match(/data-building=/g)).toHaveLength(4);
  expect(landingHtml.match(/class="strip-building[^>]+aria-hidden="true"/g)).toHaveLength(4);
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts
```

Expected: FAIL because the Strip cards only contain circular `.stop-signal` spans.

- [ ] **Step 3: Replace each signal with a building illustration tree**

Use these four building trees at the top of their matching articles:

```html
<div class="strip-building building-track" data-building="track" aria-hidden="true">
  <span class="building-antenna"></span><span class="building-cab"></span><span class="building-shell"><i></i><i></i><i></i></span>
</div>
<div class="strip-building building-garage" data-building="garage" aria-hidden="true">
  <span class="building-sign">G</span><span class="building-shell"><i class="garage-bay"></i><i class="garage-bay"></i></span>
</div>
<div class="strip-building building-upgrades" data-building="upgrades" aria-hidden="true">
  <span class="building-coil"></span><span class="building-shell"><i></i><i></i><i></i></span>
</div>
<div class="strip-building building-crates" data-building="crates" aria-hidden="true">
  <span class="crate-stack crate-stack-a"></span><span class="crate-stack crate-stack-b"></span><span class="building-shell"><i class="loading-door"></i></span>
</div>
```

Keep each article's `<b>`, `<p>`, and `<small>` content unchanged after its illustration.

- [ ] **Step 4: Implement the shared renderer and four silhouettes**

Remove `.stop-signal` and `.signal-*` rules. Add shared geometry using a card-level `--building-accent`, then specialize each silhouette:

```css
.stop-grid article {
  --building-accent: var(--green);
  min-height: 330px;
  overflow: hidden;
  isolation: isolate;
}

.stop-grid article:nth-child(2) { --building-accent: var(--cyan); }
.stop-grid article:nth-child(3) { --building-accent: var(--amber); }
.stop-grid article:nth-child(4) { --building-accent: var(--magenta); }

.strip-building {
  position: relative;
  display: flex;
  width: 100%;
  height: 138px;
  align-items: flex-end;
  justify-content: center;
  margin: -8px 0 28px;
  filter: drop-shadow(0 18px 20px rgba(0, 0, 0, 0.58));
}

.building-shell {
  position: relative;
  display: block;
  width: 78%;
  height: 82px;
  border: 1px solid color-mix(in srgb, var(--building-accent) 58%, transparent);
  background: linear-gradient(145deg, rgba(42, 45, 72, 0.96), rgba(8, 7, 19, 0.98) 65%);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.14), 0 0 28px color-mix(in srgb, var(--building-accent) 12%, transparent);
  clip-path: polygon(10px 0, 100% 0, 100% 100%, 0 100%, 0 10px);
}

.building-track .building-shell { width: 48%; height: 96px; }
.building-track .building-cab { position: absolute; bottom: 88px; width: 68%; height: 32px; border: 1px solid var(--building-accent); background: #11162a; clip-path: polygon(10px 0,calc(100% - 10px) 0,100% 100%,0 100%); }
.building-track .building-antenna { position: absolute; bottom: 120px; width: 2px; height: 18px; background: var(--building-accent); box-shadow: 0 0 12px var(--building-accent); }
.building-track .building-shell i { display: inline-block; width: 8px; height: 8px; margin: 17px 2px; border-radius: 50%; background: var(--building-accent); box-shadow: 0 0 10px var(--building-accent); }

.building-garage .building-shell { width: 94%; height: 84px; padding: 24px 10px 0; text-align: center; }
.garage-bay { display: inline-block; width: 40%; height: 58px; margin: 0 3px; border: 1px solid color-mix(in srgb,var(--building-accent) 65%,transparent); background: repeating-linear-gradient(0deg,#080b15 0 8px,#20283c 9px 10px); }
.building-sign { position: absolute; z-index: 1; bottom: 73px; display: grid; width: 38px; height: 27px; place-items: center; background: var(--building-accent); color: #041014; font-weight: 800; transform: skewX(-9deg); }

.building-upgrades .building-shell { width: 68%; height: 103px; }
.building-coil { position: absolute; z-index: 1; bottom: 24px; width: 62%; height: 92px; border-radius: 50%; background: repeating-radial-gradient(ellipse,var(--building-accent) 0 2px,transparent 3px 13px); filter: drop-shadow(0 0 8px var(--building-accent)); }

.building-crates .building-shell { width: 82%; height: 74px; }
.crate-stack { position: absolute; z-index: 1; bottom: 64px; width: 48px; height: 38px; border: 1px solid var(--building-accent); background: linear-gradient(135deg,#2c2432,#0b0914); box-shadow: inset 0 0 0 6px #0b0914, inset 0 0 0 7px color-mix(in srgb,var(--building-accent) 45%,transparent); }
.crate-stack-a { left: 17%; transform: rotate(-4deg); }
.crate-stack-b { right: 18%; bottom: 70px; transform: rotate(5deg); }
.loading-door { position: absolute; right: 14%; bottom: 0; width: 38%; height: 56px; background: repeating-linear-gradient(0deg,#080914 0 8px,color-mix(in srgb,var(--building-accent) 38%,#131323) 9px 10px); }
```

Add hover and focus-within lighting by increasing brightness on `.stop-grid article:hover .strip-building` and `.stop-grid article:focus-within .strip-building`. At the mobile breakpoint, keep buildings at least 120px tall and cards at least 285px tall so façades remain recognizable.

- [ ] **Step 5: Add reduced-motion and run verification**

Inside the reduced-motion media query, add:

```css
.stop-grid article:hover .strip-building,
.stop-grid article:focus-within .strip-building {
  transform: none;
}
```

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts && npm run build
```

Expected: landing tests PASS and the production build exits with code 0.

- [ ] **Step 6: Commit the building slice**

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: render neon Strip buildings"
```

---

### Task 3: Reactive Neon Freeway Mirage Background

**Files:**
- Modify: `redline3d/src/landing/landing-shell.test.ts`
- Modify: `redline3d/index.html:29-31`
- Modify: `redline3d/src/landing/landing.css:1-46,1168-1190`
- Modify: `redline3d/src/landing/main.ts:1-9`

**Interfaces:**
- Consumes: `window.pointermove`, optional `window.deviceorientation`, `requestAnimationFrame`, and the existing `reducedMotion` flag.
- Produces: Root custom properties `--motion-x` and `--motion-y`, each clamped to `[-1, 1]`, consumed by `.motion-plasma`, `.motion-grid`, `.motion-streaks`, and `.motion-particles`.

- [ ] **Step 1: Write the failing motion-background contract test**

Add this test:

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts
```

Expected: FAIL because neither the four motion layers nor the input adapter exists.

- [ ] **Step 3: Add the decorative motion-layer markup**

Immediately after the skip link in `index.html`, add:

```html
<div class="motion-bg" data-motion-bg aria-hidden="true">
  <div class="motion-layer motion-plasma"></div>
  <div class="motion-layer motion-grid"></div>
  <div class="motion-layer motion-streaks"></div>
  <div class="motion-layer motion-particles"></div>
</div>
```

- [ ] **Step 4: Add the frame-coalesced motion input adapter**

After the `reducedMotion` declaration in `landing/main.ts`, add:

```ts
let motionFrame = 0;
let motionX = 0;
let motionY = 0;

const clampMotion = (value: number) => Math.max(-1, Math.min(1, value));
const paintMotion = () => {
  root.style.setProperty("--motion-x", motionX.toFixed(3));
  root.style.setProperty("--motion-y", motionY.toFixed(3));
  motionFrame = 0;
};
const queueMotion = (x: number, y: number) => {
  motionX = clampMotion(x);
  motionY = clampMotion(y);
  if (!motionFrame) motionFrame = requestAnimationFrame(paintMotion);
};

if (!reducedMotion) {
  addEventListener("pointermove", (event) => {
    queueMotion((event.clientX / innerWidth) * 2 - 1, (event.clientY / innerHeight) * 2 - 1);
  }, { passive: true });

  addEventListener("deviceorientation", (event) => {
    queueMotion((event.gamma ?? 0) / 30, ((event.beta ?? 45) - 45) / 30);
  }, { passive: true });
}
```

Do not request device-orientation permission. The listener is enhancement-only and should remain inert when the browser withholds events.

- [ ] **Step 5: Render the motion field in CSS**

Add root defaults, stacking, the four layers, and keyframes:

```css
:root {
  --motion-x: 0;
  --motion-y: 0;
}

main,
.site-footer {
  position: relative;
  z-index: 1;
}

.motion-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  background: #05030d;
  pointer-events: none;
}

.motion-bg::after {
  position: absolute;
  inset: 0;
  content: "";
  background: radial-gradient(circle at 50% 22%, transparent 0 28%, rgba(5,3,13,.24) 68%, rgba(5,3,13,.76) 100%), linear-gradient(180deg,transparent,rgba(5,3,13,.58));
}

.motion-layer { position: absolute; inset: -18%; will-change: transform; }
.motion-plasma {
  background: radial-gradient(circle at 74% 15%,rgba(255,57,192,.30),transparent 24%), radial-gradient(circle at 18% 32%,rgba(39,231,255,.26),transparent 27%), radial-gradient(circle at 62% 74%,rgba(92,42,255,.25),transparent 23%);
  filter: blur(30px) saturate(1.3);
  animation: plasma-drift 18s ease-in-out infinite alternate;
}
.motion-grid {
  inset: 43% -25% -42%;
  background: repeating-linear-gradient(90deg,rgba(39,231,255,.16) 0 1px,transparent 1px 64px), repeating-linear-gradient(0deg,rgba(255,57,192,.12) 0 1px,transparent 1px 46px);
  mask-image: linear-gradient(to top,#000,transparent 92%);
  transform: perspective(420px) rotateX(62deg) translate3d(calc(var(--motion-x) * -10px),calc(var(--motion-y) * -6px),0);
  animation: grid-rush 8s linear infinite;
}
.motion-streaks {
  background: repeating-linear-gradient(116deg,transparent 0 76px,rgba(39,231,255,.11) 77px,transparent 79px 148px,rgba(255,57,192,.09) 149px,transparent 151px 230px);
  filter: drop-shadow(0 0 7px rgba(39,231,255,.28));
  animation: streak-slide 14s linear infinite;
}
.motion-particles {
  background-image: radial-gradient(circle,rgba(255,255,255,.7) 0 1px,transparent 1.5px), radial-gradient(circle,rgba(39,231,255,.75) 0 1px,transparent 1.5px);
  background-position: 0 0,37px 61px;
  background-size: 137px 137px,193px 193px;
  opacity: .26;
  transform: translate3d(calc(var(--motion-x) * 16px),calc(var(--motion-y) * 12px),0);
  animation: particles-float 24s linear infinite;
}

@keyframes plasma-drift { to { transform: translate3d(calc(var(--motion-x) * 24px + 5%),calc(var(--motion-y) * 18px - 3%),0) scale(1.08) rotate(5deg); } }
@keyframes grid-rush { to { background-position: 64px 92px; } }
@keyframes streak-slide { to { transform: translate3d(calc(var(--motion-x) * -20px - 8%),calc(var(--motion-y) * -14px + 5%),0); } }
@keyframes particles-float { to { background-position: 137px 137px,230px 254px; } }
```

Adjust the existing body background to transparent gradients over the new field and remove the duplicate star field from `body::before`. Keep `body::after` as the scanline layer. Confirm foreground section backgrounds remain translucent enough to show motion while preserving text contrast.

- [ ] **Step 6: Complete reduced-motion and responsive behavior**

Inside `@media (prefers-reduced-motion: reduce)`, add:

```css
.motion-layer {
  animation: none !important;
  transform: none !important;
  will-change: auto;
}
```

At `max-width: 760px`, reduce `.motion-streaks` opacity to `0.55` and `.motion-grid` opacity to `0.65` so the smaller text column stays legible.

- [ ] **Step 7: Run automated and visual verification**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts && npm run build
```

Expected: landing tests PASS and the production build exits with code 0.

Then run `npm run dev -- --host 127.0.0.1`, inspect the landing page at desktop and 390px widths, and verify:

- all three videos display moving footage and retain posters during load;
- all four buildings are recognizable and do not collide with their labels;
- foreground copy remains readable at the brightest plasma state;
- pointer movement shifts layers subtly without scroll jank;
- reduced-motion emulation freezes background motion and tutorial videos;
- no horizontal overflow appears at either viewport.

- [ ] **Step 8: Commit the motion slice**

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/main.ts redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: add reactive neon landing background"
```
