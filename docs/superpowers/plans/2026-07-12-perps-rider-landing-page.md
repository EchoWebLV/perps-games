# Perps Rider Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a synthwave Perps Rider marketing page at `/` with a direct launch path to the existing game at `/play/`.

**Architecture:** Convert the Vite app to an explicit two-entry build. The landing entry is semantic HTML plus isolated CSS and a very small TypeScript enhancement bundle; the existing game shell moves intact to `play/index.html` and keeps using `src/main.ts`.

**Tech Stack:** Vite 5 multi-page build, TypeScript, vanilla HTML/CSS, Vitest, Capacitor 8.

## Global Constraints

- The public brand is exactly `Perps Rider` or `PERPS RIDER`.
- `/` is the landing page and `/play/` is the game.
- Android and installed PWA launches bypass marketing and enter `/play/`.
- Landing code must not import Three.js, wallet adapters, or `src/main.ts`.
- Reuse `public/loadingscreen.png` and existing tutorial poster assets.
- Real-SOL copy must state that the player can lose the play amount.
- Preserve compatibility-critical `raider.*` storage keys and on-chain `Raider` program identifiers.

---

### Task 1: Lock the two-page routing contract

**Files:**
- Create: `redline3d/src/landing/landing-shell.test.ts`
- Modify: `redline3d/index.html`
- Create: `redline3d/play/index.html`
- Modify: `redline3d/public/manifest.webmanifest`

**Interfaces:**
- Consumes: current game shell in `redline3d/index.html`
- Produces: `/` landing markup, `/play/` game shell, CTA contract `href="/play/"`

- [ ] **Step 1: Write the failing landing contract test**

```ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

describe("landing and game shells", () => {
  it("makes root the Perps Rider landing page with a direct game link", () => {
    const html = read("index.html");
    expect(html).toContain("data-landing-page");
    expect(html).toContain('href="/play/"');
    expect(html).toContain("A real perp you drive");
    expect(html).not.toContain('/src/main.ts');
  });

  it("keeps the game shell at play and starts installed experiences there", () => {
    expect(existsSync(`${root}/play/index.html`)).toBe(true);
    expect(read("play/index.html")).toContain('/src/main.ts');
    expect(JSON.parse(read("public/manifest.webmanifest")).start_url).toBe("/play/");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts`

Expected: FAIL because the current root document is still the game shell.

- [ ] **Step 3: Move the existing game document and create the semantic landing document**

Create `play/index.html` from the current game `index.html`, then replace root `index.html` with semantic navigation, hero, three gameplay cards, strip stops, technology panels, final CTA, risk copy, and `/src/landing/main.ts`.

- [ ] **Step 4: Point installed PWA launches at the game**

Set `start_url` in `public/manifest.webmanifest` to `/play/` while keeping `scope` as `/`.

- [ ] **Step 5: Run the test and verify GREEN**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts`

Expected: 2 passing tests.

### Task 2: Add the isolated landing presentation

**Files:**
- Create: `redline3d/src/landing/landing.css`
- Create: `redline3d/src/landing/main.ts`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Consumes: `data-reveal`, `data-menu`, `data-hero-art`, and `#landing-nav` hooks from `index.html`
- Produces: native `/play/` redirect, accessible mobile navigation, progressive reveal, poster fallback

- [ ] **Step 1: Extend the test with the isolated-entry contract**

```ts
it("uses the isolated landing bundle and keeps heavy game code out", () => {
  const html = read("index.html");
  const entry = read("src/landing/main.ts");
  expect(html).toContain('/src/landing/landing.css');
  expect(html).toContain('/src/landing/main.ts');
  expect(entry).toContain('location.replace("/play/")');
  expect(entry).not.toContain("three");
  expect(entry).not.toContain("../main");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts`

Expected: FAIL because the landing entry does not exist.

- [ ] **Step 3: Implement landing CSS and progressive enhancement**

The CSS must define the existing brand tokens, desktop/mobile hero layouts, chamfered CTA, poster treatment, responsive cards, focus styles, image fallback, and reduced-motion overrides. The TypeScript must redirect native Capacitor, toggle the mobile menu, reveal sections with `IntersectionObserver`, and hide a failed hero image.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts`

Expected: 3 passing tests.

### Task 3: Configure and prove the multi-page build

**Files:**
- Modify: `redline3d/vite.config.ts`
- Modify: `redline3d/src/landing/landing-shell.test.ts`

**Interfaces:**
- Consumes: root `index.html` and `play/index.html`
- Produces: `dist/index.html` and `dist/play/index.html`

- [ ] **Step 1: Add a failing Vite input assertion**

```ts
it("registers landing and play as explicit Vite entries", () => {
  const config = read("vite.config.ts");
  expect(config).toContain('landing: fileURLToPath(new URL("index.html"');
  expect(config).toContain('play: fileURLToPath(new URL("play/index.html"');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts`

Expected: FAIL because Vite still has one implicit HTML entry.

- [ ] **Step 3: Add explicit Rollup inputs**

Set `build.rollupOptions.input` to named `landing` and `play` entries resolved with `fileURLToPath(new URL(..., import.meta.url))`, while preserving `target: "es2020"`.

- [ ] **Step 4: Run tests and production build**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts && npm run build`

Expected: all landing tests pass, Vite exits 0, and both HTML files exist in `dist`.

### Task 4: Verify the complete experience

**Files:**
- Modify only if verification exposes a defect in the files above.

**Interfaces:**
- Consumes: built landing and game entries
- Produces: verified desktop, mobile, reduced-motion, game-launch, and Android behavior

- [ ] **Step 1: Start the local Vite server**

Run: `cd redline3d && npm run dev -- --host 127.0.0.1`

Expected: server ready at `http://127.0.0.1:3000/`.

- [ ] **Step 2: Browser-check desktop and mobile**

Inspect `/` at 1440x900 and 390x844. Verify readable hierarchy, no horizontal overflow, working mobile navigation, visible risk copy, image fallback, reduced motion, and CTA navigation to `/play/`.

- [ ] **Step 3: Sync and build Android**

Run: `cd redline3d && npx cap sync android && cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug`

Expected: Capacitor sync and Android build both exit 0, packaged assets include `play/index.html`, and the APK is produced.

- [ ] **Step 4: Run final verification**

Run: `cd redline3d && npm test -- src/landing/landing-shell.test.ts src/ui/access-wall.test.ts && npm run build`

Run: `cd server && npm test -- src/auth/wallet-binding.test.ts`

Expected: zero test failures and successful production build.

- [ ] **Step 5: Commit the landing page**

```bash
git add docs/superpowers/specs/2026-07-12-perps-rider-landing-page-design.md \
  docs/superpowers/plans/2026-07-12-perps-rider-landing-page.md \
  redline3d/index.html redline3d/play/index.html redline3d/vite.config.ts \
  redline3d/public/manifest.webmanifest redline3d/src/landing
git commit -m "feat: add Perps Rider landing page"
```
