# Slopwheels Landing Rebrand + Cinematic Crate Opening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the marketing landing (`redline3d/index.html` + `src/landing/*`) to Slopwheels' gacha-first pitch and build one shared cinematic crate-opening module used by the game's real pulls and a no-stakes landing demo.

**Architecture:** The landing keeps its proven skeleton (hero → steps → strip → tech → CTA, motion system, raw-import tests) — brand, copy, art, and section themes change. A new presentation-only `src/ui/crate-cinematic.ts` owns the opening choreography (drop-in → rarity-scaled shake → rip/burst → card flip → chips) with content injected by the consumer: `cratebox.ts` mounts its existing plate/loot/reveal-car markup, the landing mounts baked card PNGs. Landing bundle isolation (no `three`, no `../main`) is enforced by existing tests and extended to the new module.

**Tech Stack:** Vite multi-entry (landing + play), TypeScript, vitest (node + jsdom), DOM/CSS animation (no video), PIL one-offs for icons/OG, browser captures for stills.

**Spec:** `docs/superpowers/specs/2026-07-25-slopwheels-landing-design.md`

**Branch:** work on `slopwheels-landing` off `main` (`git checkout -b slopwheels-landing`). All paths below are relative to `redline3d/` unless prefixed with `docs/`.

**Verified facts workers must not re-derive:** brand green ≈ `#c0f030` (sampled from `public/assets/brands/slopwheels-alpha.png`, 1024×538); 24 cars in `CAR_DEFS` (`src/main.ts:616`), 20 pullable; rarity weights 50/28/14/6/2 (`src/core/rarity.ts` TIERS); rake 5%, owner share 40% × 50/30/20 (`src/core/race-payout.ts`); 24 baked card PNGs in `public/cards/`; landing tests import files `?raw`; `test` env is node, jsdom via per-file pragma.

---

### Task 1: Brand shell — wordmark, meta, manifest, brand token

**Files:**
- Modify: `index.html` (head lines 6–14, header lines 34–37, footer line 227)
- Modify: `public/manifest.webmanifest`
- Modify: `src/landing/landing.css` (`:root` block, top of file)
- Test: `src/landing/landing-shell.test.ts`

- [ ] **Step 1: Update the shell test to expect the new brand (failing first)**

In `src/landing/landing-shell.test.ts`, replace the first `it` block's brand expectations and add wordmark/manifest assertions:

```ts
it("makes root the landing page with a direct game link", () => {
  const html = landingHtml;
  expect(html).toContain("data-landing-page");
  expect(html).toContain('href="/play/"');
  expect(html).toContain("Crack a crate");                 // was "A real perp you drive"
  expect(html).toContain("You can lose your play amount"); // risk note survives
  expect(html).not.toContain('/src/main.ts');
});

it("wears the Slopwheels brand everywhere the shell shows a name", () => {
  expect(landingHtml).toContain("<title>Slopwheels");
  expect(landingHtml).toContain("assets/brands/slopwheels-alpha.png");
  expect(landingHtml).not.toContain("PERPS</span>");
  const manifest = JSON.parse(manifestText);
  expect(manifest.name).toBe("Slopwheels");
  expect(manifest.short_name).toBe("Slopwheels");
});
```

Keep the existing APK test unchanged (`/downloads/perps-rider.apk` + "Download Seeker APK" both stay).

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `npx vitest run src/landing/landing-shell.test.ts`
Expected: FAIL on "Crack a crate", "<title>Slopwheels", wordmark, manifest name.

- [ ] **Step 3: Edit `index.html` head + wordmarks**

Head (replace lines 6–14 equivalents):

```html
<title>Slopwheels | Crack crates. Bet the race.</title>
<meta name="description" content="Crack crates, collect slop cars across five rarity tiers, and bet the pari-mutuel pool on chaotic grand-prix races. Podium owners take a cut of the rake." />
<meta name="apple-mobile-web-app-title" content="Slopwheels" />
<meta property="og:title" content="Slopwheels" />
<meta property="og:description" content="Crack a crate. Bet the race." />
<meta property="og:image" content="/assets/landing/og-slopwheels.png" />
```

(`theme-color`, manifest/icon links, fonts: unchanged.)

Header wordmark (replace lines 35–37):

```html
<a class="wordmark" href="/" aria-label="Slopwheels home">
  <img src="/assets/brands/slopwheels-alpha.png" alt="Slopwheels" />
</a>
```

Footer wordmark (line 227): same `<img>` swap. Footer tagline (line 228): `Built for the slop. Running on Solana devnet.`

- [ ] **Step 4: Update `public/manifest.webmanifest`**

```json
"name": "Slopwheels",
"short_name": "Slopwheels",
"description": "Gacha racing arcade — crack crates, collect slop cars, bet the race.",
```

(icons/colors/start_url unchanged.)

- [ ] **Step 5: Add the brand token + wordmark/CTA styling in `landing.css`**

In `:root` after `--amber: #ffd166;`:

```css
--brand: #c0f030;
--brand-soft: rgba(192, 240, 48, 0.16);
```

Below the existing `.wordmark` rules add (keep old rules; the img needs sizing):

```css
.wordmark img { height: 34px; width: auto; display: block; }
.site-footer .wordmark img { height: 28px; }
```

Retoken CTAs: in the existing `.launch-button`, `.nav-launch`, and `.live-dot` rules, replace their accent color usages (cyan/magenta values) with `var(--brand)` / `var(--brand-soft)` for background/border/glow. Search: `grep -n "launch-button\|nav-launch\|live-dot" src/landing/landing.css` and update each rule's color values in place — visual judgement allowed, hue must be the brand green.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/landing/landing-shell.test.ts src/landing/main.test.ts`
Expected: PASS (main.test.ts mounts its own fixture DOM — if it hard-codes the old wordmark markup, update the fixture to the `<img>` form).

- [ ] **Step 7: Commit**

```bash
git add index.html public/manifest.webmanifest src/landing/landing.css src/landing/landing-shell.test.ts src/landing/main.test.ts
git commit -m "brand: slopwheels landing shell (wordmark, meta, manifest, brand token)"
```

---

### Task 2: Hero + How-it-works rewrite (PULL / BET / WIN)

**Files:**
- Modify: `index.html` (hero section lines 50–78, `#how` section lines 80–115)
- Modify: `src/landing/landing.css` (step accent classes only if renamed — keep `step-cyan/step-amber/step-magenta` class names to avoid CSS churn)
- Test: `src/landing/landing-shell.test.ts`

- [ ] **Step 1: Failing test for the new story**

Add to `landing-shell.test.ts`:

```ts
it("tells the gacha story: pull, bet, win", () => {
  expect(landingHtml).toContain("Crack a crate.");
  expect(landingHtml).toContain("Bet the race.");
  expect(landingHtml).toMatch(/01 \/ PULL/);
  expect(landingHtml).toMatch(/02 \/ BET/);
  expect(landingHtml).toMatch(/03 \/ WIN/);
  expect(landingHtml).toContain("CARS</small> 20+");
  expect(landingHtml).toContain("pari-mutuel");
  expect(landingHtml).not.toContain("Rev the engine");
});
```

Run: `npx vitest run src/landing/landing-shell.test.ts` → FAIL.

- [ ] **Step 2: Rewrite the hero copy in `index.html`**

```html
<div class="eyebrow"><span class="live-dot"></span> Gacha racing arcade on Solana devnet</div>
<h1 id="hero-title">Crack a crate.<br />Bet the race.</h1>
<p class="hero-lede">Pull crates for a garage of gloriously stupid cars — five rarity tiers, dupes melt to scrap. Send yours to the grand prix, bet the pari-mutuel pool against seven rivals, and take a cut of the rake when your car podiums.</p>
```

Actions block: button labels unchanged (Launch game / Download Seeker APK / See how it works). Play-note: `<b>Practice free.</b> Sign in only when you want real VRF pulls and real SOL.` Proof row:

```html
<div class="proof-row" aria-label="Game highlights">
  <span><small>CARS</small> 20+ and counting</span>
  <span><small>RARITY TIERS</small> 5</span>
  <span><small>PODIUM</small> Owners get paid</span>
</div>
```

Hero poster: `src` → `/assets/landing/hero-grandprix.png` (created in Task 8; broken img until then is expected — `data-hero-art` error-hides it gracefully). Alt: "Slopwheels toon cars lined up on the grand-prix grid". Figcaption:

```html
<span><i></i> GRID FORMING</span>
<b>BET THE RACE</b>
```

- [ ] **Step 3: Rewrite the `#how` section**

Heading block: `<h2 id="how-title">Three moves.<br /><em>One grid.</em></h2>` and `<p>Every pull, every bet, every payout is one loop: collect the slop, back it with money.</p>`. The three `step-card`s keep their classes and `<video>` markup shape but each `<video>` gains `poster` + sources pointing at new step media (files land in Task 8):

- Card 1 (`step-cyan`): poster `/assets/landing/step-pull.webp`, remove `<source>` tags (no clips yet — poster-only renders as the still), copy: `<span>01 / PULL</span><h3>Crack crates</h3><p>Every pull rolls the odds — five tiers from junk to legendary. Dupes melt into scrap.</p>`
- Card 2 (`step-amber`): poster `/assets/landing/step-bet.webp`, copy: `<span>02 / BET</span><h3>Back your car</h3><p>Send it to the grid and bet the pari-mutuel pool. No car? Watch and bet anyway.</p>`
- Card 3 (`step-magenta`): poster `/assets/landing/step-win.webp`, copy: `<span>03 / WIN</span><h3>Get paid</h3><p>The pool settles to the cent. Top-3 finishers pay their owners a slice of the rake.</p>`

A `<video>` with only a `poster` shows the poster image — keep `data-tutorial-video` off these three (nothing to play) by REMOVING that attribute; playback wiring stays for the perps section (Task 3).

- [ ] **Step 4: Run tests, then commit**

Run: `npx vitest run src/landing/` → PASS.

```bash
git add index.html src/landing/landing-shell.test.ts
git commit -m "landing: gacha-first hero + pull/bet/win steps"
```

---

### Task 3: Mode 2 perps section + strip copy + CTA/footer + video-section state

**Files:**
- Modify: `index.html` (strip section lines 117–151, new section after it, final CTA lines 214–223, nav lines 41–46)
- Modify: `src/landing/motion-state.ts` (+ its test)
- Modify: `src/landing/main.ts`
- Test: `src/landing/landing-shell.test.ts`, `src/landing/motion-state.test.ts`

- [ ] **Step 1: Failing shell test**

```ts
it("keeps perps as mode 2 with its real numbers", () => {
  expect(landingHtml).toContain('id="mode2"');
  expect(landingHtml).toContain("real perp");
  expect(landingHtml).toContain("10× to 3000×");
  expect(landingHtml).toContain("/tutorial/leverage.webm");
  expect(landingHtml).toContain('href="#mode2"');
});
```

Run → FAIL.

- [ ] **Step 2: Strip copy touch-ups (`#strip`)**

Section heading `<p>` → `Drive the lobby between races — every stop feeds the collection.` Cards: TRACK `<p>Send a car to the grand prix.</p>`; GARAGE `<p>Show off what you pulled.</p>`; UPGRADES unchanged; CRATES `<p>Where the pulls happen.</p>`.

- [ ] **Step 3: New `#mode2` section between `#strip` and `#built-on`**

```html
<section id="mode2" class="section-shell content-section" aria-labelledby="mode2-title" data-motion-section="mode2">
  <div class="section-heading" data-reveal>
    <div><span class="section-index">03</span><span class="eyebrow">Mode 2 · The highway</span></div>
    <h2 id="mode2-title">There's a real perp<br /><em>under the hood.</em></h2>
    <p>The original Perps Rider mode lives inside Slopwheels. Pick BTC, ETH, or SOL, rev your leverage from 10× to 3000×, and bank the position before liquidation becomes a wreck. Live prices by Pyth Lazer.</p>
  </div>
  <div class="step-grid mode2-grid">
    <article class="step-card step-cyan" data-reveal>
      <div class="step-media">
        <video loop muted playsinline preload="metadata" poster="/tutorial/leverage.webp" data-tutorial-video aria-hidden="true">
          <source src="/tutorial/leverage.webm" type="video/webm" />
          <source src="/tutorial/leverage.mp4" type="video/mp4" />
        </video>
      </div>
      <div class="step-copy"><span>REV</span><h3>Leverage is the throttle</h3><p>More revs, more leverage. Both directions hit harder.</p></div>
    </article>
    <article class="step-card step-magenta" data-reveal>
      <div class="step-media">
        <video loop muted playsinline preload="metadata" poster="/tutorial/cash-out.webp" data-tutorial-video aria-hidden="true">
          <source src="/tutorial/cash-out.webm" type="video/webm" />
          <source src="/tutorial/cash-out.mp4" type="video/mp4" />
        </video>
      </div>
      <div class="step-copy"><span>BANK</span><h3>Exit before impact</h3><p>Cash out to keep it. Liquidation takes the play amount.</p></div>
    </article>
  </div>
</section>
```

Add `.mode2-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }` to `landing.css` next to the existing `.step-grid` rule, inheriting its responsive collapse (mirror whatever media query `.step-grid` uses).

Renumber the visible `section-index` spans so the page reads 01 (how) / 02 (strip) / 03 (mode2) / 04 (built-on) — update `#built-on`'s index span from `03` to `04`.

Nav (line 41–46): add `<a href="#mode2">Mode 2</a>` between "The strip" and "Built on".

- [ ] **Step 4: Per-section video playback in motion-state**

Current `motion-state.ts` (30 lines) tracks a single `tutorialVisible` boolean; two video sections would fight. Change the state to a Set of visible video sections:

```ts
// motion-state.ts — replace the tutorial-visible event/flag with:
export interface MotionState {
  reduced: boolean;
  documentVisible: boolean;
  videoSections: ReadonlySet<string>;   // was: tutorialVisible: boolean
  technologyVisible: boolean;
}
export type MotionEvent =
  | { type: "system-reduced"; reduced: boolean }
  | { type: "document-visible"; visible: boolean }
  | { type: "video-section"; id: string; visible: boolean }   // was: tutorial-visible
  | { type: "technology-visible"; visible: boolean };

// in the reducer:
case "video-section": {
  const next = new Set(state.videoSections);
  if (event.visible) next.add(event.id); else next.delete(event.id);
  return { ...state, videoSections: next };
}

/** video playback allowed inside `sectionId` right now */
export const videoPlaybackEnabled = (s: MotionState, sectionId: string): boolean =>
  motionEnabled(s) && s.videoSections.has(sectionId);
```

Delete `tutorialPlaybackEnabled`; keep `technologyMotionEnabled` as-is. Update `motion-state.test.ts`: replace `tutorial-visible` cases with `video-section` cases — two sections independently visible, one leaving doesn't pause the other:

```ts
it("tracks video sections independently", () => {
  let s = initialMotionState(false);
  s = reduceMotionState(s, { type: "video-section", id: "tutorial", visible: true });
  s = reduceMotionState(s, { type: "video-section", id: "mode2", visible: true });
  s = reduceMotionState(s, { type: "video-section", id: "tutorial", visible: false });
  expect(videoPlaybackEnabled(s, "mode2")).toBe(true);
  expect(videoPlaybackEnabled(s, "tutorial")).toBe(false);
});
```

- [ ] **Step 5: Wire main.ts to per-section playback**

In `src/landing/main.ts`: the section observer (lines 51–56) dispatches `{ type: "video-section", id: section, visible }` for any `data-motion-section` that is not `"technology"` (technology keeps its own event). `renderMotionState` plays/pauses per section:

```ts
document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((sec) => {
  const id = sec.dataset.motionSection!;
  if (id === "technology") return;
  sec.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]").forEach((video) => {
    if (videoPlaybackEnabled(motionState, id)) void video.play().catch(() => undefined);
    else video.pause();
  });
});
```

`#how` keeps `data-motion-section="tutorial"` (its videos are gone, so this is now inert but harmless); `#mode2` uses `data-motion-section="mode2"`. Update `main.test.ts` fixture/expectations accordingly (it spies on `play`/`pause`).

- [ ] **Step 6: Run + commit**

Run: `npx vitest run src/landing/` → PASS.

```bash
git add index.html src/landing/landing.css src/landing/motion-state.ts src/landing/motion-state.test.ts src/landing/main.ts src/landing/main.test.ts src/landing/landing-shell.test.ts
git commit -m "landing: mode-2 perps section, strip copy, per-section video state"
```

---

### Task 4: Tech section retheme (VRF pulls + pari-mutuel tote scene)

**Files:**
- Modify: `index.html` (`#built-on` section lines 153–212)
- Modify: `src/landing/landing.css` (new `.scene-tote` rules)
- Test: `src/landing/landing-shell.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("rethemes the tech rack to pulls, pools, settlement, world", () => {
  expect(landingHtml).toContain("EPHEMERAL VRF / PROVABLY FAIR");
  expect(landingHtml).toContain("Pari-mutuel");
  expect(landingHtml).toContain("settles to the cent");
  expect(landingHtml).not.toContain("scene-price");   // price scene moved out with the perps pitch
});
```

Run → FAIL.

- [ ] **Step 2: Retheme the four cards in `index.html`**

- Card 01 (was Pyth price): becomes **PULLS / MagicBlock VRF**. Reuse the existing MagicBlock rollup-chamber scene markup from the current card 02 (move it here), status line `EPHEMERAL VRF / PROVABLY FAIR`, copy block: `<small>PULLS</small><h3>MagicBlock VRF</h3><p>Signed-in crate pulls roll on-chain randomness — provably fair, not a server dice.</p>`. Delete the old `scene-price` markup entirely (the perps section covers Pyth attribution in its heading copy).
- Card 02: becomes **RACES / Pari-mutuel engine** with a new tote-board scene in the house SVG style:

```html
<div class="tech-scene scene-tote" data-tech-scene="tote" aria-hidden="true">
  <svg viewBox="0 0 280 130">
    <path class="tote-grid" d="M0 30H280M0 60H280M0 90H280M70 8V122M140 8V122M210 8V122"/>
    <g class="tote-rows">
      <rect x="12" y="18" width="120" height="14" rx="4"/>
      <rect x="12" y="48" width="96" height="14" rx="4"/>
      <rect x="12" y="78" width="140" height="14" rx="4"/>
    </g>
    <g class="tote-odds"><text x="240" y="30">x21.8</text><text x="240" y="60">x4.2</text><text x="240" y="90">x1.9</text></g>
    <path class="tote-payline" d="M8 112H272"/>
  </svg>
  <span class="scene-status">POOL LOCKED / SETTLED TO THE CENT</span>
</div>
```

Copy: `<small>RACES</small><h3>Pari-mutuel pools</h3><p>Odds come from the pool, not the house. 5% rake — and podium owners get a slice of it. Settles to the cent.</p>`

`landing.css` additions (place next to other `.tech-scene` rules; match their visual language):

```css
.scene-tote .tote-grid { stroke: var(--line); fill: none; }
.scene-tote .tote-rows rect { fill: var(--panel-solid); stroke: var(--line-strong); }
.scene-tote .tote-odds text { fill: var(--brand); font: 700 13px var(--font); }
.scene-tote .tote-payline { stroke: var(--brand); stroke-dasharray: 8 6; animation: tote-pay 2.4s linear infinite; }
@keyframes tote-pay { to { stroke-dashoffset: -28; } }
.motion-paused .scene-tote .tote-payline { animation: none; }
```

- Cards 03 (Solana) and 04 (Social open world): unchanged.

Section heading `<p>` → `The slop is silly. The rails are not.`

- [ ] **Step 3: Run + commit**

Run: `npx vitest run src/landing/` → PASS. Also `npx tsc --noEmit`.

```bash
git add index.html src/landing/landing.css src/landing/landing-shell.test.ts
git commit -m "landing: tech rack rethemed to VRF pulls + pari-mutuel tote"
```

---

### Task 5: `crate-cinematic` module (TDD, presentation-only)

**Files:**
- Create: `src/ui/crate-cinematic.ts`
- Test: `src/ui/crate-cinematic.test.ts`

The module is pure DOM + injected CSS, importable by the landing bundle: **no imports from three, main.ts, cratebox, or the economy.** Only `import { tierOf } from "../core/rarity"` is allowed.

**API (lock this down exactly):**

```ts
export interface CinematicPrizeChip { label: string; color?: string }
export interface CinematicRevealOpts {
  rarity: number;                       // 1..5 → drama scale
  onCardSlot: (slot: HTMLElement) => void; // consumer fills the card face at flip time
  chips?: CinematicPrizeChip[];         // e.g. "+250 SCRAP", "LEVEL: NEON DOCKS"
  doneLabel?: string;                   // default "Done"
  hideDone?: boolean;                   // game mode: cratebox keeps its own Done/again bar
}
export interface CrateCinematicRun {
  reveal(opts: CinematicRevealOpts): void; // rip → flip; call once
  abort(): void;                           // tear down without reveal (VRF failure)
}
export interface CrateCinematic {
  el: HTMLElement;                       // overlay root, consumer appends where it wants
  open(opts: { crateImgUrl?: string; crateColor: string; loop?: boolean }): CrateCinematicRun;
  dispose(): void;
}
export function createCrateCinematic(opts: { lowTier?: boolean; onDone: () => void }): CrateCinematic;
```

**Beats (class names are the contract the test asserts):** `open()` → root gets `ccx-on`, crate node `.ccx-crate` gets `drop-in`, then `shake` (or `shakeloop` when `loop`). `reveal({rarity})` → shake escalates: crate gets `shake-r${rarity}` for `SHAKE_EXTRA_MS[rarity]` = `{1:200, 2:350, 3:600, 4:1100, 5:1800}` ms → crate gets `gone`, flash `.ccx-flash` gets `go` (scale 1.5 when rarity ≥ 4) → after 230ms card `.ccx-card` gets `flip-in` and `onCardSlot(slotEl)` fires → chips stagger in at 90ms each → done button appears, click → `onDone()`. `prefers-reduced-motion` or `lowTier`: skip the escalate wait (0ms) and drop `drop-in`/`shake` in favor of a fade. All timers via `setTimeout`/`requestAnimationFrame` — the test drives them with `vi.useFakeTimers()`.

- [ ] **Step 1: Write the failing test**

`src/ui/crate-cinematic.test.ts` (jsdom pragma at top):

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrateCinematic, SHAKE_EXTRA_MS } from "./crate-cinematic";

describe("crate-cinematic", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const boot = () => {
    const onDone = vi.fn();
    const cx = createCrateCinematic({ onDone });
    document.body.appendChild(cx.el);
    return { cx, onDone };
  };

  it("plays drop-in → shake → rip → flip → chips → done for a legendary", () => {
    const { cx, onDone } = boot();
    const run = cx.open({ crateColor: "#ffd166" });
    const crate = cx.el.querySelector(".ccx-crate")!;
    expect(crate.classList.contains("drop-in")).toBe(true);
    vi.advanceTimersByTime(500); // drop-in settles → shake
    expect(crate.classList.contains("shake")).toBe(true);

    const onCardSlot = vi.fn();
    run.reveal({ rarity: 5, onCardSlot, chips: [{ label: "+800 SCRAP" }] });
    expect(crate.classList.contains("shake-r5")).toBe(true);
    vi.advanceTimersByTime(SHAKE_EXTRA_MS[5]);
    expect(crate.classList.contains("gone")).toBe(true);
    expect(cx.el.querySelector(".ccx-flash")!.classList.contains("go")).toBe(true);
    vi.advanceTimersByTime(230);
    expect(onCardSlot).toHaveBeenCalledOnce();
    expect(cx.el.querySelector(".ccx-card")!.classList.contains("flip-in")).toBe(true);
    vi.advanceTimersByTime(90);
    expect(cx.el.querySelectorAll(".ccx-chip.in").length).toBe(1);

    (cx.el.querySelector(".ccx-done") as HTMLButtonElement).click();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("loops the shake until reveal (VRF wait) and aborts cleanly", () => {
    const { cx } = boot();
    const run = cx.open({ crateColor: "#c3ccd8", loop: true });
    vi.advanceTimersByTime(500);
    expect(cx.el.querySelector(".ccx-crate")!.classList.contains("shakeloop")).toBe(true);
    run.abort();
    expect(cx.el.classList.contains("ccx-on")).toBe(false);
  });

  it("commons rip fast, legendaries slow-burn", () => {
    expect(SHAKE_EXTRA_MS[1]).toBeLessThan(SHAKE_EXTRA_MS[5]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/ui/crate-cinematic.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/ui/crate-cinematic.ts`**

Structure (implement fully — the beats/classes/timings from the contract above; CSS injected once via a module-level `<style>` with a `ccx-` prefix, following the embedded-CSS pattern in `src/ui/bet-panel.ts`):

```ts
import { tierOf } from "../core/rarity";

export const SHAKE_EXTRA_MS: Record<number, number> = { 1: 200, 2: 350, 3: 600, 4: 1100, 5: 1800 };
const DROP_MS = 500, FLASH_MS = 230, CHIP_STAGGER_MS = 90;

// injected once; keyframes for drop-in/shake/shakeloop/gone/flash/flip-in/chip-in,
// escalation via .shake-r1..r5 { --amp: … } amplitude custom property, tier glow via
// box-shadow color from the crate/tier color custom prop --tc. Full-screen fixed overlay,
// z-index above game HUD; @media (prefers-reduced-motion: reduce) collapses animations to fades.
const CSS = `…full stylesheet here…`;
```

`createCrateCinematic` builds: overlay root (`.ccx-root`) → stage with `.ccx-crate` (img when `crateImgUrl`, colored box fallback like cratebox line 348–350), `.ccx-flash`, `.ccx-card` (rarity-colored frame + empty `.ccx-slot`), `.ccx-chips`, `.ccx-done` button. `open()` resets state, adds `ccx-on`, runs drop-in → shake timer; returns the run object closing over the DOM. `reveal()` uses `tierOf(rarity)` for the frame color, sequences the timers exactly as the test drives them. `dispose()` removes the root and clears pending timers (track ids in a Set). Guard double-`reveal()` (second call no-ops).

- [ ] **Step 4: Run tests until green**

Run: `npx vitest run src/ui/crate-cinematic.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Guard bundle isolation**

Add to `landing-shell.test.ts` (with the other raw imports):

```ts
import crateCinematicSrc from "../ui/crate-cinematic.ts?raw";

it("keeps the crate cinematic importable by the landing bundle", () => {
  expect(crateCinematicSrc).not.toContain('from "three"');
  expect(crateCinematicSrc).not.toContain('"../main"');
  expect(crateCinematicSrc).not.toContain('"./cratebox"');
});
```

Run: `npx vitest run src/landing/landing-shell.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/crate-cinematic.ts src/ui/crate-cinematic.test.ts src/landing/landing-shell.test.ts
git commit -m "feat: shared cinematic crate-opening module (drop/shake/rip/flip, rarity-scaled)"
```

---

### Task 6: Game integration — cratebox delegates its opening beats

**Files:**
- Modify: `src/ui/cratebox.ts` (lines 304–361: `showShop`, `showReveal`, `showCrateAnim`, `burstToReveal`; plus the VRF failure paths that re-enter the shop)
- Test: `src/ui/cratebox.test.ts`

Behavioral contract: economics, VRF flow, grants, and the reveal CONTENT (halo, plate, gems, scrap pile, level poster, revealCar viewer, "again" button) are unchanged — only the choreography moves to the module.

- [ ] **Step 1: Read `src/ui/cratebox.test.ts` end to end** and note which selectors it drives (`.cb-*`). Tests that assert shake/flash classes will move to `ccx-` equivalents; tests that assert reveal content stay on `.cb-*`.

- [ ] **Step 2: Update the failing tests first** — wherever the test asserts `.cb-crate3d`/`.cb-crate` shake classes or `.cb-flash`, retarget to `.ccx-crate` / `.ccx-flash` inside the cratebox panel. Add one new case: a paid coin pull mounts the reveal content inside `.ccx-slot` (i.e. `panel.querySelector(".ccx-slot .cb-plate")` exists after timers run). Run: `npx vitest run src/ui/cratebox.test.ts` → FAIL.

- [ ] **Step 3: Integrate**

In `cratebox.ts`:

```ts
import { createCrateCinematic, type CrateCinematicRun } from "./crate-cinematic";
```

After `revealCar` creation (line 250):

```ts
const cinematic = createCrateCinematic({ lowTier: deps.lowTier, onDone: () => (giftMode ? close() : showShop()) });
stage.appendChild(cinematic.el);
let run: CrateCinematicRun | null = null;
```

Replace `showCrateAnim(crate, loop)` body: hide rows/btns as today, then `run = cinematic.open({ crateImgUrl: cratePng[crate.key], crateColor: crate.color, loop })`. Replace `burstToReveal(...)` body:

```ts
run?.reveal({
  rarity: car.rarity ?? 1,
  chips: [
    { label: `+${scrap} SCRAP` },
    ...(lvlKey ? [{ label: `LEVEL: ${deps.levelInfo(lvlKey)?.name ?? lvlKey}` }] : []),
    ...(vrf ? [{ label: "⛓ MagicBlock VRF" }] : []),
  ],
  onCardSlot: (slot) => mountRevealContent(slot, crate, car, isNew, scrap, lvlKey, vrf),
});
```

`mountRevealContent` is `showReveal` re-targeted: same innerHTML (halo/plate/loot markup from lines 318–331) written into `slot` instead of `stage`, then `revealCar.show(...)` into the carslot. The "Done / again" buttons stay in the cratebox `btns` bar exactly as today (lines 336–340); the game passes `hideDone: true` so the module's `.ccx-done` never shows (the landing omits it and uses the module's button). Abort paths: everywhere the current code bails after `showCrateAnim` (VRF rejection, SOL failure — the `catch`/failure branches around lines 384–427), call `run?.abort()` before `showShop()`.

- [ ] **Step 4: Run the full crate suite**

Run: `npx vitest run src/ui/` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/cratebox.ts src/ui/cratebox.test.ts src/ui/crate-cinematic.ts src/ui/crate-cinematic.test.ts
git commit -m "feat: cratebox opens through the shared cinematic (economics untouched)"
```

---

### Task 7: Landing demo — "Crack one open"

**Files:**
- Create: `src/landing/demo-crate.ts` (data + roll + wiring)
- Modify: `index.html` (new section directly after the hero, before `#how`)
- Modify: `src/landing/main.ts` (one import + init call)
- Modify: `src/landing/landing.css` (demo section styling)
- Test: `src/landing/demo-crate.test.ts`, `src/landing/landing-shell.test.ts`

- [ ] **Step 1: Failing data-sync test**

The landing cannot import `CAR_DEFS` (bundle isolation), so `demo-crate.ts` carries its own manifest. A test keeps it honest against `src/main.ts` and `public/cards/`:

```ts
// src/landing/demo-crate.test.ts
import { describe, expect, it } from "vitest";
import { DEMO_CARS, rollDemo } from "./demo-crate";
import mainSrc from "../main.ts?raw";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("landing demo crate", () => {
  it("mirrors every pullable CAR_DEFS entry (name + rarity)", () => {
    // parse `{ name: "X", rarity: N, ... }` rows; pool:false / comingSoon rows are excluded
    const defs = [...mainSrc.matchAll(/\{ name: "([^"]+)"[^\n]*?rarity: (\d)[^\n]*/g)]
      .filter((m) => !/pool: false|comingSoon: true/.test(m[0]))
      .map((m) => ({ name: m[1], rarity: Number(m[2]) }));
    expect(defs.length).toBeGreaterThanOrEqual(20);
    expect(DEMO_CARS.map((c) => c.name).sort()).toEqual(defs.map((d) => d.name).sort());
    for (const d of defs) expect(DEMO_CARS.find((c) => c.name === d.name)!.rarity).toBe(d.rarity);
  });

  it("points every demo car at a real baked card", () => {
    const cards = readdirSync(fileURLToPath(new URL("../../public/cards/", import.meta.url)));
    for (const c of DEMO_CARS) expect(cards).toContain(c.card.replace("/cards/", ""));
  });

  it("rolls with the real tier odds", () => {
    // r-values chosen against cumulative weights 50/28/14/6/2
    expect(rollDemo(0.99, 0.5)!.rarity).toBe(5);
    expect(rollDemo(0.10, 0.5)!.rarity).toBe(1);
  });
});
```

Run: `npx vitest run src/landing/demo-crate.test.ts` → FAIL.

**Note:** `CAR_DEFS` rows are one-per-line object literals (`src/main.ts:616–648`) — the regex above works against that shape; if it under-matches, fix the regex, not the format.

- [ ] **Step 2: Implement `src/landing/demo-crate.ts`**

```ts
import { rollCrate } from "../core/crate";
import { TIERS, tierOf } from "../core/rarity";
import { createCrateCinematic } from "../ui/crate-cinematic";

export interface DemoCar { name: string; rarity: number; card: string }
// Mirrors the pullable CAR_DEFS roster (test-enforced against src/main.ts).
export const DEMO_CARS: DemoCar[] = [
  { name: "DeLorean", rarity: 4, card: "/cards/delorean.png" },
  { name: "Cybertruck", rarity: 3, card: "/cards/cybertruck.png" },
  // … all 20 pullable cars; card filenames from public/cards/ (kebab-case of the name;
  // verify each against the directory listing — the sync test catches mistakes)
];

const FAIR_WEIGHTS = Object.fromEntries(TIERS.map((t) => [t.id, t.weight]));
export const rollDemo = (rTier: number, rCar: number) => rollCrate(DEMO_CARS, FAIR_WEIGHTS, rTier, rCar);

export function initDemoCrate(): void {
  const mount = document.querySelector<HTMLElement>("[data-demo-crate]");
  if (!mount) return;
  const button = mount.querySelector<HTMLButtonElement>("[data-demo-open]")!;
  const cx = createCrateCinematic({ onDone: () => { /* overlay closes itself */ } });
  mount.appendChild(cx.el);
  button.addEventListener("click", () => {
    const car = rollDemo(Math.random(), Math.random());
    if (!car) return;
    const t = tierOf(car.rarity);
    const run = cx.open({ crateColor: t.color });
    window.setTimeout(() => run.reveal({
      rarity: car.rarity,
      chips: [{ label: t.name, color: t.color }],
      doneLabel: "Crack another",
      onCardSlot: (slot) => {
        slot.innerHTML =
          `<img class="demo-card-art" src="${car.card}" alt="${car.name} card" />` +
          `<b class="demo-card-name" style="--tc:${t.color}">${car.name}</b>` +
          `<a class="launch-button demo-keep" href="/play/"><span>Play to keep what you pull</span><b aria-hidden="true">GO!</b></a>`;
      },
    }), 900); // let the shake breathe before the rip
  });
}
```

(`rollCrate(cars, tierWeights, r1, r2)` from `src/core/crate.ts` accepts any `PoolLike` rows — `DemoCar` qualifies with `rarity` alone.)

- [ ] **Step 3: Section markup + wiring**

`index.html`, directly after the hero `</section>`:

```html
<section id="crack" class="section-shell content-section demo-crate" aria-labelledby="crack-title" data-demo-crate>
  <div class="section-heading compact" data-reveal>
    <div><span class="eyebrow">Try it right here</span></div>
    <h2 id="crack-title">Crack one open.</h2>
    <p>Same odds as the real thing — 50 / 28 / 14 / 6 / 2. This one's on the house and stays on this page.</p>
  </div>
  <button class="launch-button demo-open" type="button" data-demo-open><span>Crack a crate</span><b aria-hidden="true">RIP</b></button>
</section>
```

`src/landing/main.ts` (bottom): `import { initDemoCrate } from "./demo-crate";` + `initDemoCrate();`. Add landing-shell assertions: `expect(landingHtml).toContain('data-demo-crate')` and extend the isolation test — `demo-crate.ts?raw` must not contain `from "three"` / `"../main"`. Style `.demo-crate` (centered, brand-green button) and `.demo-card-art` (`max-width: min(320px, 70vw)`) in `landing.css`.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run src/landing/` → PASS. `npx tsc --noEmit` → clean.

```bash
git add src/landing/demo-crate.ts src/landing/demo-crate.test.ts index.html src/landing/main.ts src/landing/landing.css src/landing/landing-shell.test.ts
git commit -m "feat: landing demo crate — crack one open with real odds, baked card art"
```

---

### Task 8: Media captures (ORCHESTRATOR TASK — not a subagent)

**Files:**
- Create: `public/assets/landing/hero-grandprix.png`, `og-slopwheels.png`, `step-pull.webp`, `step-bet.webp`, `step-win.webp`

The orchestrator drives the Browser pane (subagents don't have the running session's preview): dev server `redline3d` (launch.json, port 4000).

- [ ] **Step 1: Hero + OG** — open `http://localhost:4000/race-preview.html`, pick a full-grid dusk angle, screenshot at desktop viewport; crop/resize with PIL: hero at native capture size (PNG), OG at 1200×630 (PNG, < 400 KB).
- [ ] **Step 2: Step stills** — in the app (`/play/`): (a) Store tab mid-cinematic card flip for `step-pull`; (b) grandprix market phase, bet panel over the grid for `step-bet`; (c) settlement overlay with a payout for `step-win`. Each cropped to 16:9 and saved 640×360 webp via PIL (`img.resize((640,360)).save(path, "WEBP", quality=82)`).
- [ ] **Step 3: Verify + commit** — load the landing, confirm hero + three stills render (no 404s in the network tab).

```bash
git add public/assets/landing/
git commit -m "assets: slopwheels landing captures (hero, og, step stills)"
```

---

### Task 9: Icons (PIL one-off)

**Files:**
- Modify: `public/icon-192.png`, `public/icon-512.png`, `public/icon.svg`

- [ ] **Step 1: Generate PNGs** — one-off python3/PIL: 512×512 black canvas with 20%-radius rounded corners (alpha outside), `slopwheels-alpha.png` pasted centered at 80% width; downscale a copy to 192. Overwrite both files.
- [ ] **Step 2: Regenerate `icon.svg`** — `<svg viewBox="0 0 512 512">` with the rounded rect and the 512 PNG embedded as a base64 `<image>`.
- [ ] **Step 3: Verify + commit** — open the landing, check the favicon in the tab; `git add public/icon-*.png public/icon.svg && git commit -m "brand: slopwheels app icons"`.

---

### Task 10: Full verification + bundle isolation

- [ ] **Step 1:** `npx vitest run` → all green (baseline was 1077 passed | 9 skipped; expect additions, zero regressions).
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** `npm run build` → clean; then inspect `dist/assets/` — the landing entry chunk must not contain three/game code: `grep -l "WebGLRenderer" dist/assets/landing-*.js` must match nothing (game chunks may; landing chunk may not).
- [ ] **Step 4 (orchestrator):** Live proof at desktop and 375×812 — zero console errors; wordmark + hero render; demo crate cracks through drop-in → shake → rip → flip → "Play to keep what you pull" → `/play/`; mode-2 videos play when scrolled into view and pause when out; nav anchors incl. `#mode2` scroll; in-game Store pull still reveals correctly through the new cinematic (grant + scrap + again-button intact). Screenshots shared.
- [ ] **Step 5:** Commit any fixes; hand the branch back for merge per `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- Spec §1 → Task 1 + 9; §2 → Tasks 2, 3, 4; §3 → Task 8; §4 → Tasks 5, 6, 7; §5 → every task's test steps + Task 10. No uncovered spec requirement.
- `hideDone` is part of the Task 5 API contract; the game (Task 6) passes it, the landing (Task 7) omits it.
- Landing references `/assets/landing/hero-grandprix.png` and step stills from Task 2 onward; files exist only after Task 8 — tests never load images, and `data-hero-art`'s error handler hides a missing poster, so intermediate states are safe.
