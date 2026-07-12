# Strip Building Renders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rejected CSS building drawings with transparent isometric WebP renders generated from the real Perps Rider Three.js models.

**Architecture:** A dedicated Vite-served render page imports the existing building constructors and draws one model into a transparent Three.js canvas. A Puppeteer script captures all four canvases into committed WebP assets; the production landing page only loads those lightweight images and does not import Three.js.

**Tech Stack:** Three.js, TypeScript, Vite, Puppeteer, HTML, CSS, Vitest.

## Global Constraints

- Use `buildTrack`, `buildGarage`, `buildUpgrades`, and `buildCrates` as the source of truth.
- Do not redesign or duplicate the in-game building geometry.
- Do not import Three.js into the production landing entry.
- Generate transparent WebP assets at 1024 by 720 pixels.
- Use one consistent orthographic camera and lighting rig for all four renders.
- Preserve existing Strip labels and descriptions.
- Preserve the approved tutorial videos and dynamic background.
- Use no em dashes in copy or documentation.

## File Structure

- Create `redline3d/building-renderer.html`: development-only host for the capture canvas.
- Create `redline3d/src/landing/building-renderer.ts`: builds, lights, frames, and renders one requested model.
- Create `redline3d/scripts/render-landing-buildings.mjs`: starts Vite, opens Chrome, and writes four WebP files.
- Create `redline3d/src/landing/building-renderer.test.ts`: raw-source contract for the render scene and capture pipeline.
- Create `redline3d/public/assets/landing/building-{track,garage,upgrades,crates}.webp`: committed outputs.
- Modify `redline3d/package.json`: add the reproducible render command.
- Modify `redline3d/index.html`: use the four generated images.
- Modify `redline3d/src/landing/landing.css`: remove CSS geometry and style the rendered assets.
- Modify `redline3d/src/landing/landing-shell.test.ts`: replace the rejected-geometry contract with the image contract.

---

### Task 1: Reproducible Three.js Building Capture Pipeline

**Files:**
- Create: `redline3d/building-renderer.html`
- Create: `redline3d/src/landing/building-renderer.ts`
- Create: `redline3d/scripts/render-landing-buildings.mjs`
- Create: `redline3d/src/landing/building-renderer.test.ts`
- Modify: `redline3d/package.json`
- Create: `redline3d/public/assets/landing/building-track.webp`
- Create: `redline3d/public/assets/landing/building-garage.webp`
- Create: `redline3d/public/assets/landing/building-upgrades.webp`
- Create: `redline3d/public/assets/landing/building-crates.webp`

**Interfaces:**
- Consumes: `buildTrack(color, track)`, `buildGarage(color, track)`, `buildUpgrades(color, track)`, and `buildCrates(color, track)`.
- Produces: `npm run render:landing-buildings` and four 1024 by 720 transparent WebP assets under `public/assets/landing/`.

- [ ] **Step 1: Write the failing render-pipeline contract test**

Create `building-renderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import rendererHtml from "../../building-renderer.html?raw";
import rendererSource from "./building-renderer.ts?raw";
import captureSource from "../../scripts/render-landing-buildings.mjs?raw";
import packageText from "../../package.json?raw";

describe("landing building renderer", () => {
  it("renders the real game buildings through a transparent orthographic scene", () => {
    expect(rendererHtml).toContain('/src/landing/building-renderer.ts');
    for (const builder of ["buildTrack", "buildGarage", "buildUpgrades", "buildCrates"]) {
      expect(rendererSource).toContain(builder);
    }
    expect(rendererSource).toContain("OrthographicCamera");
    expect(rendererSource).toContain("alpha: true");
    expect(rendererSource).toContain('dataset.ready = "true"');
  });

  it("captures every building as a committed WebP", () => {
    for (const building of ["track", "garage", "upgrades", "crates"]) {
      expect(captureSource).toContain(`"${building}"`);
      expect(captureSource).toContain(`building-${building}.webp`);
    }
    expect(captureSource).toContain('type: "webp"');
    expect(captureSource).toContain("omitBackground: true");
    expect(JSON.parse(packageText).scripts["render:landing-buildings"]).toBe("node scripts/render-landing-buildings.mjs");
  });
});
```

- [ ] **Step 2: Run the test and confirm the red state**

Run:

```bash
cd redline3d && npx vitest run src/landing/building-renderer.test.ts
```

Expected: FAIL because the renderer page, renderer module, and capture script do not exist.

- [ ] **Step 3: Add the renderer host page**

Create `building-renderer.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Building Renderer</title></head>
  <body style="margin:0;overflow:hidden;background:transparent">
    <script type="module" src="/src/landing/building-renderer.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Implement the fixed render scene**

Create `building-renderer.ts` with:

```ts
import * as THREE from "three";
import { buildTrack } from "../render/buildings/track";
import { buildGarage } from "../render/buildings/garage";
import { buildUpgrades } from "../render/buildings/upgrades";
import { buildCrates } from "../render/buildings/crates";
import type { BuiltBuilding, Track } from "../render/buildings/types";

const WIDTH = 1024;
const HEIGHT = 720;
const requested = new URLSearchParams(location.search).get("building") ?? "track";
const definitions: Record<string, { color: number; time: number; build: (color: number, track: Track) => BuiltBuilding }> = {
  track: { color: 0x2ee6a6, time: 2.7, build: buildTrack },
  garage: { color: 0x27e7ff, time: 1.2, build: buildGarage },
  upgrades: { color: 0xffd166, time: 0.5, build: buildUpgrades },
  crates: { color: 0xff39c0, time: 1.6, build: buildCrates },
};
const definition = definitions[requested];
if (!definition) throw new Error(`Unknown building: ${requested}`);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-28.45, 28.45, 20, -20, 0.1, 200);
camera.position.set(38, 30, 42);
camera.lookAt(0, 10, 0);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);

const resources: Array<{ dispose(): void }> = [];
const track: Track = (resource) => { resources.push(resource); return resource; };
const building = definition.build(definition.color, track);
const bounds = new THREE.Box3().setFromObject(building.group);
const center = bounds.getCenter(new THREE.Vector3());
building.group.position.set(-center.x, -bounds.min.y, -center.z);
building.group.traverse((object) => {
  if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
});
scene.add(building.group);

scene.add(new THREE.HemisphereLight(0x8fb7ff, 0x14061f, 2.1));
const key = new THREE.DirectionalLight(0xffd9f6, 4.2);
key.position.set(-28, 42, 30);
key.castShadow = true;
scene.add(key);
const rim = new THREE.DirectionalLight(0x27e7ff, 3.3);
rim.position.set(34, 24, -26);
scene.add(rim);

const shadow = new THREE.Mesh(new THREE.PlaneGeometry(42, 32), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42 }));
shadow.rotation.x = -Math.PI / 2;
shadow.receiveShadow = true;
scene.add(shadow);

building.animate?.(definition.time);
renderer.render(scene, camera);
document.documentElement.dataset.ready = "true";
```

- [ ] **Step 5: Implement the Puppeteer capture command**

Create `render-landing-buildings.mjs`:

```js
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { createServer } from "vite";

export const BUILDINGS = ["track", "garage", "upgrades", "crates"];
const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(root, "public", "assets", "landing");

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  try { candidates.unshift(puppeteer.executablePath()); } catch { /* use system candidates */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* try next */ }
  }
  throw new Error("Chrome not found. Set CHROME_PATH to an executable browser.");
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const vite = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port.");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await puppeteer.launch({ headless: true, executablePath: await findChrome() });
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 720, deviceScaleFactor: 1 });

    for (const building of BUILDINGS) {
      await page.goto(`${origin}/building-renderer.html?building=${building}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
      const canvas = await page.$("canvas");
      if (!canvas) throw new Error(`Renderer produced no canvas for ${building}.`);
      await canvas.screenshot({
        path: join(outputDir, `building-${building}.webp`),
        type: "webp",
        omitBackground: true,
      });
    }
  } finally {
    await browser?.close();
    await vite.close();
  }
}

await main();
```

Add to `package.json`:

```json
"render:landing-buildings": "node scripts/render-landing-buildings.mjs"
```

- [ ] **Step 6: Run the render contract and generate all assets**

Run:

```bash
cd redline3d && npx vitest run src/landing/building-renderer.test.ts && npm run render:landing-buildings
```

Expected: 2 tests PASS and four non-empty WebP files are created under `public/assets/landing/`.

- [ ] **Step 7: Verify dimensions and commit the pipeline**

Run:

```bash
cd redline3d && file public/assets/landing/building-*.webp && npm run build
```

Expected: each file reports WebP at 1024 by 720 and the production build exits with code 0.

Commit:

```bash
git add redline3d/building-renderer.html redline3d/src/landing/building-renderer.ts redline3d/src/landing/building-renderer.test.ts redline3d/scripts/render-landing-buildings.mjs redline3d/package.json redline3d/public/assets/landing
git commit -m "feat: render real landing building assets"
```

---

### Task 2: Replace Rejected CSS Geometry With Model Renders

**Files:**
- Modify: `redline3d/src/landing/landing-shell.test.ts`
- Modify: `redline3d/index.html`
- Modify: `redline3d/src/landing/landing.css`

**Interfaces:**
- Consumes: the four generated `/assets/landing/building-*.webp` files from Task 1.
- Produces: four `.strip-building img` elements with stable intrinsic dimensions and no nested `.building-shell` geometry.

- [ ] **Step 1: Replace the old building test with a failing image contract**

Replace `renders four distinct decorative buildings on the Strip` with:

```ts
it("shows real model renders for all four Strip buildings", () => {
  for (const building of ["track", "garage", "upgrades", "crates"]) {
    expect(landingHtml).toContain(`src="/assets/landing/building-${building}.webp"`);
  }
  expect(landingHtml.match(/class="strip-building"/g)).toHaveLength(4);
  expect(landingHtml.match(/width="1024" height="720"/g)).toHaveLength(4);
  expect(landingHtml.match(/loading="lazy" decoding="async" alt=""/g)).toHaveLength(4);
  expect(landingHtml).not.toContain("building-shell");
  expect(landingHtml).not.toContain("building-coil");
  expect(landingHtml).not.toContain("crate-stack");
});
```

- [ ] **Step 2: Run the landing test and confirm the red state**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts
```

Expected: FAIL because the Strip still contains CSS geometry.

- [ ] **Step 3: Replace each geometry tree with its generated image**

Use this exact structure, changing the filename for each building:

```html
<div class="strip-building">
  <img src="/assets/landing/building-track.webp" width="1024" height="720" loading="lazy" decoding="async" alt="" />
</div>
```

Keep all `<b>`, `<p>`, and `<small>` content unchanged.

- [ ] **Step 4: Delete the rejected renderer and style the assets**

Remove every building-specific geometry selector from `.building-shell` through `.loading-door`. Keep the card accent tokens and replace the renderer styles with:

```css
.strip-building {
  position: relative;
  display: grid;
  width: calc(100% + 24px);
  height: 170px;
  place-items: center;
  margin: -20px -12px 20px;
  transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.strip-building::after {
  position: absolute;
  right: 12%;
  bottom: 4px;
  left: 12%;
  height: 18px;
  border-radius: 50%;
  background: var(--building-accent);
  content: "";
  filter: blur(18px);
  opacity: 0.2;
}

.strip-building img {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 22px 24px rgba(0, 0, 0, 0.6));
  transition: filter 0.3s ease, transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.stop-grid article:hover .strip-building img {
  filter: brightness(1.12) drop-shadow(0 25px 28px rgba(0, 0, 0, 0.7));
  transform: translateY(-5px) scale(1.035);
}
```

At `max-width: 760px`, use `height: 190px`, `width: 100%`, and `margin: -10px 0 18px`. In reduced motion, set the hover image transform to `none`.

- [ ] **Step 5: Run automated and visual verification**

Run:

```bash
cd redline3d && npx vitest run src/landing/landing-shell.test.ts src/landing/building-renderer.test.ts && npm run build
```

Expected: all renderer and landing tests PASS and the production build exits with code 0.

Open `http://127.0.0.1:3000/#strip` at 1440 by 900 and 390 by 844. Verify real model detail, transparent backgrounds, consistent camera scale, centered composition, readable text, and zero horizontal overflow.

- [ ] **Step 6: Commit the landing replacement**

```bash
git add redline3d/index.html redline3d/src/landing/landing.css redline3d/src/landing/landing-shell.test.ts
git commit -m "fix: replace Strip drawings with game renders"
```
