# Technology Pipeline and Social World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a four-stage animated Price to Social Open World pipeline while adding one accessible motion controller and resolving the final landing-page review findings.

**Architecture:** Inline SVG scenes remain semantic, responsive, and dependency-free. A small pure motion-state module decides whether motion is allowed; `landing/main.ts` adapts browser events, visibility observers, tutorial video playback, and the header control to that state. CSS owns scene rendering and compositor-friendly background motion.

**Tech Stack:** HTML, inline SVG, CSS transforms and opacity, TypeScript DOM APIs, Vitest, Vite.

## Global Constraints

- The pipeline order is Price, Execution, Settlement, Social Open World.
- Preserve the existing first three technology descriptions exactly.
- Use exact Social Open World copy from the approved spec.
- Technology scenes must not use Three.js, canvas, video, official logos, or external assets.
- Optional motion stops when offscreen, when the document is hidden, when the user chooses Motion Off, or when the operating system requests reduced motion.
- The motion toggle uses `aria-pressed`, stays visible at all breakpoints, and persists in `sessionStorage` under `perps-rider:motion-paused`.
- Operating-system reduced motion always overrides the user toggle.
- Large background movement uses transform and opacity, not animated `background-position`.
- Tutorial videos play only while visible and motion is enabled.
- Production landing code remains free of Three.js and Capacitor imports.
- Use no em dashes in copy or documentation.

## File Structure

- Create `redline3d/src/landing/motion-state.ts`: pure state and derived motion selectors.
- Create `redline3d/src/landing/motion-state.test.ts`: transition tests for user, system, visibility, tutorial, and technology states.
- Modify `redline3d/index.html`: motion button, four technology cards, inline SVG scenes, and nested background layers.
- Modify `redline3d/src/landing/main.ts`: browser adapter for state, observers, playback, storage, and normalized pointer input.
- Modify `redline3d/src/landing/landing.css`: motion control, SVG scenes, responsive grid, paused states, and compositor background.
- Modify `redline3d/src/landing/landing-shell.test.ts`: semantic and dependency contracts.
- Modify `redline3d/src/landing/building-renderer.test.ts`: binary validation of committed WebP assets.

---

### Task 1: Global Motion State and Media Visibility

**Files:**
- Create: `redline3d/src/landing/motion-state.ts`
- Create: `redline3d/src/landing/motion-state.test.ts`
- Modify: `redline3d/index.html`
- Modify: `redline3d/src/landing/main.ts`
- Modify: `redline3d/src/landing/landing.css`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Produces: `MotionState`, `initialMotionState(userPaused, systemReduced)`, `motionEnabled(state)`, `tutorialPlaybackEnabled(state)`, `technologyMotionEnabled(state)`, and `reduceMotionState(state, event)`.
- Produces DOM hooks: `[data-motion-toggle]`, root classes `.motion-paused` and `.tech-motion-active`, and storage key `perps-rider:motion-paused`.

- [ ] **Step 1: Write the failing pure-state tests**

Create `motion-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";

const motionModules = import.meta.glob("./motion-state.ts");

async function loadMotionState() {
  expect(Object.keys(motionModules)).toHaveLength(1);
  return Object.values(motionModules)[0]() as Promise<any>;
}

describe("landing motion state", () => {
  it("lets system reduction override the user preference", async () => {
    const { initialMotionState, motionEnabled, reduceMotionState } = await loadMotionState();
    const state = initialMotionState(false, true);
    expect(motionEnabled(state)).toBe(false);
    expect(reduceMotionState(state, { type: "user-paused", paused: false })).toEqual(state);
  });

  it("runs tutorial and technology motion only while visible", async () => {
    const { initialMotionState, reduceMotionState, technologyMotionEnabled, tutorialPlaybackEnabled } = await loadMotionState();
    let state = initialMotionState(false, false);
    expect(tutorialPlaybackEnabled(state)).toBe(false);
    expect(technologyMotionEnabled(state)).toBe(false);
    state = reduceMotionState(state, { type: "tutorial-visible", visible: true });
    state = reduceMotionState(state, { type: "technology-visible", visible: true });
    expect(tutorialPlaybackEnabled(state)).toBe(true);
    expect(technologyMotionEnabled(state)).toBe(true);
  });

  it("stops everything while the document is hidden or the user pauses", async () => {
    const { initialMotionState, motionEnabled, reduceMotionState } = await loadMotionState();
    let state = initialMotionState(false, false);
    state = reduceMotionState(state, { type: "document-visible", visible: false });
    expect(motionEnabled(state)).toBe(false);
    state = reduceMotionState(state, { type: "document-visible", visible: true });
    state = reduceMotionState(state, { type: "user-paused", paused: true });
    expect(motionEnabled(state)).toBe(false);
  });

  it("reacts when the system preference changes", async () => {
    const { initialMotionState, motionEnabled, reduceMotionState } = await loadMotionState();
    const state = reduceMotionState(initialMotionState(false, false), { type: "system-reduced", reduced: true });
    expect(state.systemReduced).toBe(true);
    expect(motionEnabled(state)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run `cd redline3d && npx vitest run src/landing/motion-state.test.ts`.

Expected: FAIL because `motion-state.ts` does not exist.

- [ ] **Step 3: Implement the pure state module**

Create `motion-state.ts`:

```ts
export interface MotionState {
  userPaused: boolean;
  systemReduced: boolean;
  documentVisible: boolean;
  tutorialVisible: boolean;
  technologyVisible: boolean;
}

export type MotionEvent =
  | { type: "user-paused"; paused: boolean }
  | { type: "system-reduced"; reduced: boolean }
  | { type: "document-visible" | "tutorial-visible" | "technology-visible"; visible: boolean };

export const initialMotionState = (userPaused: boolean, systemReduced: boolean): MotionState => ({
  userPaused,
  systemReduced,
  documentVisible: true,
  tutorialVisible: false,
  technologyVisible: false,
});

export const motionEnabled = (state: MotionState) => !state.userPaused && !state.systemReduced && state.documentVisible;
export const tutorialPlaybackEnabled = (state: MotionState) => motionEnabled(state) && state.tutorialVisible;
export const technologyMotionEnabled = (state: MotionState) => motionEnabled(state) && state.technologyVisible;

export function reduceMotionState(state: MotionState, event: MotionEvent): MotionState {
  switch (event.type) {
    case "user-paused": return state.systemReduced ? state : { ...state, userPaused: event.paused };
    case "system-reduced": return { ...state, systemReduced: event.reduced };
    case "document-visible": return { ...state, documentVisible: event.visible };
    case "tutorial-visible": return { ...state, tutorialVisible: event.visible };
    case "technology-visible": return { ...state, technologyVisible: event.visible };
  }
}
```

- [ ] **Step 4: Add the motion-control landing contract**

Add a failing test to `landing-shell.test.ts` that asserts:

```ts
expect(landingHtml).toContain("data-motion-toggle");
expect(landingHtml).toContain('aria-pressed="true"');
const entry = Object.values(landingScripts)[0] as string;
expect(entry).toContain('"perps-rider:motion-paused"');
expect(entry).toContain('reduceMotion.addEventListener("change"');
expect(entry).toContain('addEventListener("visibilitychange"');
expect(landingHtml).toContain('data-motion-section="tutorial"');
expect(landingHtml).toContain('data-motion-section="technology"');
```

Run the landing test. Expected: FAIL because the control and adapter do not exist.

- [ ] **Step 5: Add the visible header control and section hooks**

Insert after the wordmark:

```html
<button class="motion-toggle" type="button" aria-pressed="true" data-motion-toggle>MOTION ON</button>
```

Add `data-motion-section="tutorial"` to `#how` and `data-motion-section="technology"` to `#built-on`.

- [ ] **Step 6: Replace the one-time motion code with the state adapter**

Import the state module and use this adapter shape in `main.ts`:

```ts
import { initialMotionState, motionEnabled, reduceMotionState, technologyMotionEnabled, tutorialPlaybackEnabled } from "./motion-state";

const MOTION_STORAGE_KEY = "perps-rider:motion-paused";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const toggle = document.querySelector<HTMLButtonElement>("[data-motion-toggle]");
const tutorialVideos = document.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]");
let motionState = initialMotionState(sessionStorage.getItem(MOTION_STORAGE_KEY) === "true", reduceMotion.matches);

const renderMotionState = () => {
  const enabled = motionEnabled(motionState);
  document.documentElement.classList.toggle("motion-paused", !enabled);
  document.documentElement.classList.toggle("tech-motion-active", technologyMotionEnabled(motionState));
  if (toggle) {
    toggle.textContent = enabled ? "MOTION ON" : "MOTION OFF";
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.disabled = motionState.systemReduced;
  }
  tutorialVideos.forEach((video) => {
    if (tutorialPlaybackEnabled(motionState)) void video.play().catch(() => undefined);
    else video.pause();
  });
};

const dispatchMotion = (event: Parameters<typeof reduceMotionState>[1]) => {
  motionState = reduceMotionState(motionState, event);
  renderMotionState();
};

toggle?.addEventListener("click", () => {
  const paused = !motionState.userPaused;
  sessionStorage.setItem(MOTION_STORAGE_KEY, String(paused));
  dispatchMotion({ type: "user-paused", paused });
});
reduceMotion.addEventListener("change", (event) => dispatchMotion({ type: "system-reduced", reduced: event.matches }));
document.addEventListener("visibilitychange", () => dispatchMotion({ type: "document-visible", visible: !document.hidden }));

const sectionObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
  const section = (entry.target as HTMLElement).dataset.motionSection;
  if (section === "tutorial") dispatchMotion({ type: "tutorial-visible", visible: entry.isIntersecting });
  if (section === "technology") dispatchMotion({ type: "technology-visible", visible: entry.isIntersecting });
}), { threshold: 0.12 });
document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((section) => sectionObserver.observe(section));
renderMotionState();
```

Pointer and orientation callbacks must call `motionEnabled(motionState)` before queuing updates.

- [ ] **Step 7: Style paused state and the header control**

Add:

```css
.motion-toggle {
  min-height: 38px;
  margin-left: auto;
  margin-right: 14px;
  padding: 0 13px;
  border: 1px solid rgba(39, 231, 255, 0.38);
  background: rgba(39, 231, 255, 0.07);
  color: var(--cyan);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.12em;
  cursor: pointer;
}

.motion-toggle[aria-pressed="false"],
.motion-toggle:disabled {
  border-color: var(--line-strong);
  background: rgba(12, 10, 26, 0.72);
  color: var(--muted);
}

html.motion-paused .motion-layer,
html.motion-paused .tech-scene *,
html:not(.tech-motion-active) .tech-scene * {
  animation-play-state: paused !important;
}

@media (max-width: 760px) {
  .motion-toggle { min-height: 36px; margin-right: 8px; padding-inline: 9px; font-size: 8px; }
}
```

- [ ] **Step 8: Verify and commit**

Run:

```bash
cd redline3d && npx vitest run src/landing/motion-state.test.ts src/landing/landing-shell.test.ts && npm run build
```

Expected: all focused tests PASS and build exits 0.

Commit:

```bash
git add redline3d/index.html redline3d/src/landing/motion-state.ts redline3d/src/landing/motion-state.test.ts redline3d/src/landing/main.ts redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: add accessible landing motion control"
```

---

### Task 2: Four Animated Technology Pipeline Scenes

**Files:**
- Modify: `redline3d/index.html`
- Modify: `redline3d/src/landing/landing.css`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Consumes: `.tech-motion-active` and `.motion-paused` from Task 1.
- Produces: `[data-tech-scene="price|execution|settlement|world"]`, four inline SVGs, and exact Social Open World copy.

- [ ] **Step 1: Write the failing technology pipeline contract**

Add:

```ts
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
```

Run the landing test. Expected: FAIL with no `data-tech-scene` hooks.

- [ ] **Step 2: Replace the technology card markup**

Use four articles with `--tech-delay` values `0s`, `.35s`, `.7s`, and `1.05s`. Each article keeps its number and text and adds one `aria-hidden="true"` scene. Use these SVG primitives:

```html
<div class="tech-scene scene-price" data-tech-scene="price" aria-hidden="true">
  <svg viewBox="0 0 280 130"><path class="scene-grid" d="M0 25H280M0 65H280M0 105H280M55 0V130M140 0V130M225 0V130"/><path class="price-trace" d="M8 96L48 78L82 86L119 43L157 58L198 29L236 48L272 18"/><g class="price-nodes"><circle cx="48" cy="78" r="4"/><circle cx="119" cy="43" r="4"/><circle cx="198" cy="29" r="4"/><circle cx="272" cy="18" r="4"/></g><rect class="price-laser" x="0" y="0" width="3" height="130"/></svg><span class="scene-status">BTC · ETH · SOL / LIVE</span>
</div>
<div class="tech-scene scene-execution" data-tech-scene="execution" aria-hidden="true">
  <svg viewBox="0 0 280 130"><g class="rollup-blocks"><rect x="25" y="20" width="64" height="22"/><rect x="25" y="54" width="64" height="22"/><rect x="25" y="88" width="64" height="22"/></g><path class="execution-lane" d="M100 65H238"/><circle class="execution-packet" cx="105" cy="65" r="7"/><rect class="rollup-core" x="188" y="34" width="62" height="62" rx="8"/><path class="execution-check" d="M205 65L220 79L239 50"/></svg><span class="scene-status">EPHEMERAL ROLLUP / CONFIRMED</span>
</div>
<div class="tech-scene scene-settlement" data-tech-scene="settlement" aria-hidden="true">
  <svg viewBox="0 0 280 130"><circle class="signature-ring ring-a" cx="140" cy="63" r="47"/><circle class="signature-ring ring-b" cx="140" cy="63" r="31"/><rect class="wallet-core" x="111" y="42" width="58" height="42" rx="7"/><path class="wallet-signature" d="M120 72C130 46 137 84 147 57S158 74 164 53"/><circle class="settlement-seal" cx="202" cy="91" r="18"/><path class="seal-check" d="M193 91L200 98L212 83"/></svg><span class="scene-status">SIGNED / SETTLED</span>
</div>
<div class="tech-scene scene-world" data-tech-scene="world" aria-hidden="true">
  <svg viewBox="0 0 280 130"><path class="world-grid" d="M18 108L140 15L262 108M55 108L140 40L225 108M18 108H262M45 84H235M73 62H207"/><g class="world-nodes"><circle cx="55" cy="84" r="5"/><circle cx="140" cy="40" r="5"/><circle cx="225" cy="84" r="5"/><circle cx="140" cy="108" r="5"/></g><rect class="world-car car-a" x="77" y="73" width="18" height="9" rx="3"/><rect class="world-car car-b" x="187" y="72" width="18" height="9" rx="3"/><circle class="presence-ping" cx="140" cy="40" r="12"/></svg><span class="scene-status">DRIVERS ONLINE / SHARED STRIP</span>
</div>
```

- [ ] **Step 3: Build the four-column visual system**

Replace the existing technology rules with this structure, then add scene-specific color and geometry rules for the class names in Step 2:

```css
.tech-grid { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.tech-grid::before { position: absolute; top: 105px; right: 8%; left: 8%; height: 1px; background: linear-gradient(90deg,var(--cyan),var(--magenta),var(--green)); content: ""; opacity: .28; }
.tech-grid article { --tech-accent: var(--cyan); position: relative; min-height: 330px; padding: 20px; overflow: hidden; border: 1px solid var(--line); background: rgba(10,8,23,.78); }
.tech-grid article:nth-child(2) { --tech-accent: var(--magenta); }
.tech-grid article:nth-child(3) { --tech-accent: var(--green); }
.tech-grid article:nth-child(4) { --tech-accent: var(--amber); }
.tech-scene { position: relative; height: 150px; margin: -4px -4px 22px; overflow: hidden; color: var(--tech-accent); pointer-events: none; }
.tech-scene svg { width: 100%; height: 130px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 2; }
.scene-grid,.world-grid { opacity: .14; }
.price-trace,.execution-lane,.signature-ring { filter: drop-shadow(0 0 7px currentColor); }
.price-nodes circle,.execution-packet,.world-nodes circle,.world-car { fill: currentColor; stroke: none; }
.rollup-blocks rect,.rollup-core,.wallet-core { fill: color-mix(in srgb,var(--tech-accent) 13%,transparent); }
.scene-status { position: absolute; right: 6px; bottom: 0; color: color-mix(in srgb,var(--tech-accent) 72%,white); font-size: 7px; letter-spacing: .12em; }
.price-laser { fill: currentColor; stroke: none; animation: price-scan 3.2s ease-in-out infinite; }
.price-nodes circle,.world-nodes circle { animation: node-pulse 2.2s ease-in-out infinite; }
.execution-packet { animation: packet-run 2.7s cubic-bezier(.2,.8,.2,1) infinite; }
.rollup-blocks { transform-origin: 188px 65px; animation: block-compress 2.7s ease-in-out infinite; }
.ring-a { transform-origin: 140px 63px; animation: ring-turn 5s linear infinite; }
.ring-b { transform-origin: 140px 63px; animation: ring-turn 3.5s linear infinite reverse; }
.settlement-seal,.seal-check { transform-origin: 202px 91px; animation: seal-lock 2.8s ease-in-out infinite; }
.car-a { animation: car-route 3.8s ease-in-out infinite; }
.car-b { animation: car-route 3.8s ease-in-out 1.2s infinite reverse; }
.presence-ping { transform-origin: 140px 40px; animation: presence-pulse 2.4s ease-out infinite; }
.tech-scene * { animation-delay: var(--tech-delay,0s); }
@keyframes price-scan { 0%,12%{transform:translateX(0);opacity:0} 25%{opacity:1} 75%{opacity:1} 88%,100%{transform:translateX(270px);opacity:0} }
@keyframes node-pulse { 0%,100%{opacity:.32;transform:scale(.8)} 50%{opacity:1;transform:scale(1.35)} }
@keyframes packet-run { 0%,18%{transform:translateX(0);opacity:0} 30%{opacity:1} 72%{transform:translateX(116px);opacity:1} 85%,100%{transform:translateX(132px);opacity:0} }
@keyframes block-compress { 0%,35%{transform:scaleX(1);opacity:1} 67%,100%{transform:translateX(80px) scaleX(.25);opacity:.2} }
@keyframes ring-turn { to{transform:rotate(360deg)} }
@keyframes seal-lock { 0%,55%{transform:scale(.4);opacity:0} 72%,100%{transform:scale(1);opacity:1} }
@keyframes car-route { 0%,100%{transform:translate(0,0)} 50%{transform:translate(52px,-28px)} }
@keyframes presence-pulse { 0%{transform:scale(.3);opacity:.8} 100%{transform:scale(2.4);opacity:0} }
@media (max-width:1100px){.tech-grid{grid-template-columns:repeat(2,1fr)}.tech-grid::before{display:none}}
@media (max-width:760px){.tech-grid{grid-template-columns:1fr}.tech-scene{height:150px}}
```

- [ ] **Step 4: Add paused composed frames**

Ensure each scene is visually meaningful with animation paused at delay `0s`. Keep all SVGs decorative and prevent pointer events. Hover may increase brightness but must not be required to understand the scene.

- [ ] **Step 5: Verify and commit**

Run focused tests and `npm run build`. Inspect desktop and mobile technology layouts.

Commit:

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "feat: animate the technology social pipeline"
```

---

### Task 3: Compositor Background and Normalized Input

**Files:**
- Modify: `redline3d/index.html`
- Modify: `redline3d/src/landing/main.ts`
- Modify: `redline3d/src/landing/landing.css`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Produces normalized unitless root properties `--motion-x` and `--motion-y` in `[-1, 1]`.
- Produces one inner `<span>` per `.motion-layer`, with ambient transforms isolated from pointer parallax.

- [ ] **Step 1: Strengthen the motion-field contract**

Require four `.motion-layer` elements containing `<span>`, require `setProperty("--motion-x", motionX.toFixed(3))`, reject `--motion-near-x`, and reject keyframes that animate `background-position`.

Run the landing test. Expected: FAIL on scaled pixel properties and old background keyframes.

- [ ] **Step 2: Nest ambient layer spans**

Change every background layer to:

```html
<div class="motion-layer motion-plasma"><span></span></div>
```

Repeat for grid, streaks, and particles.

- [ ] **Step 3: Normalize TypeScript input**

Make `paintMotion` write only:

```ts
root.style.setProperty("--motion-x", motionX.toFixed(3));
root.style.setProperty("--motion-y", motionY.toFixed(3));
```

Keep `clampMotion` and the frame-coalesced queue. Ignore pointer and orientation events when `motionEnabled(motionState)` is false.

- [ ] **Step 4: Move visual depth and ambient travel into CSS**

Move each existing layer background to its child span. Use these outer transforms and ambient keyframes, retaining the existing gradient definitions on the matching spans:

```css
.motion-layer { position:absolute; inset:-18%; }
.motion-layer>span { position:absolute; inset:-8%; display:block; }
.motion-plasma { transform:translate3d(calc(var(--motion-x) * 18px),calc(var(--motion-y) * 14px),0); }
.motion-grid { transform:translate3d(calc(var(--motion-x) * -7px),calc(var(--motion-y) * -5px),0); }
.motion-streaks { transform:translate3d(calc(var(--motion-x) * -7px),calc(var(--motion-y) * -5px),0); }
.motion-particles { transform:translate3d(calc(var(--motion-x) * 28px),calc(var(--motion-y) * 21px),0); }
.motion-plasma>span { animation:ambient-plasma 18s ease-in-out infinite alternate; }
.motion-grid>span { transform-origin:bottom; animation:ambient-grid 8s linear infinite; }
.motion-streaks>span { animation:ambient-streaks 14s linear infinite; }
.motion-particles>span { animation:ambient-particles 24s linear infinite; }
html:not(.motion-paused) .motion-layer,
html:not(.motion-paused) .motion-layer>span { will-change:transform; }
html.motion-paused .motion-layer>span { animation-play-state:paused!important; will-change:auto; }
@keyframes ambient-plasma { from{transform:translate3d(-3%,-2%,0) scale(1.04)} to{transform:translate3d(4%,3%,0) scale(1.1)} }
@keyframes ambient-grid { from{transform:perspective(420px) rotateX(62deg) translateY(0)} to{transform:perspective(420px) rotateX(62deg) translateY(46px)} }
@keyframes ambient-streaks { from{transform:translate3d(-5%,-4%,0)} to{transform:translate3d(6%,5%,0)} }
@keyframes ambient-particles { from{transform:translate3d(0,0,0)} to{transform:translate3d(70px,80px,0)} }
@media(max-width:760px){.motion-streaks{display:none}.motion-particles{opacity:.18}}
```

Delete `plasma-drift`, `grid-rush`, `streak-slide`, and `particles-float` and all `background-position` animation declarations.

- [ ] **Step 5: Verify and commit**

Run focused tests and the production build. Use the browser performance panel or computed styles to confirm normalized values and transforms update without console errors.

Commit:

```bash
git add redline3d/index.html redline3d/src/landing/main.ts redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "perf: move landing motion to compositor transforms"
```

---

### Task 4: Decode and Validate Committed Building Assets

**Files:**
- Modify: `redline3d/src/landing/building-renderer.test.ts`

**Interfaces:**
- Consumes: four committed `public/assets/landing/building-*.webp` files.
- Produces: real binary assertions for RIFF/WebP, VP8X, alpha, and 1024 by 720 dimensions.

- [ ] **Step 1: Write the binary validation helper and assertions**

Add this test helper and test:

```ts
import { readFile } from "node:fs/promises";

const readU24 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

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
```

- [ ] **Step 2: Prove the test catches missing assets**

Temporarily rename one file outside the repository, run the focused test and observe an `ENOENT` failure, then restore the file before continuing. Do not commit the rename.

- [ ] **Step 3: Run GREEN and commit**

Run:

```bash
cd redline3d && npx vitest run src/landing/building-renderer.test.ts
```

Expected: all renderer tests PASS.

Commit:

```bash
git add redline3d/src/landing/building-renderer.test.ts
git commit -m "test: validate committed building image binaries"
```

---

### Task 5: Full Verification and Review

**Files:**
- Verify only; no planned production edits.

- [ ] **Step 1: Run all automated checks**

```bash
cd redline3d && npm test && npm run build
```

Expected: all non-devnet tests PASS, devnet-only tests remain skipped, and build exits 0.

- [ ] **Step 2: Verify the complete browser story**

At 1440 by 900, 1024 by 768, and 390 by 844 verify all four scenes, pipeline order, connector behavior, Social Open World copy, Motion On/Off, session persistence, live reduced-motion changes, tutorial visibility playback, background pause, normalized parallax, zero overflow, and zero console errors.

- [ ] **Step 3: Review the final diff**

Run `git diff --check`, confirm a clean worktree, and perform a final whole-branch review before integration.
