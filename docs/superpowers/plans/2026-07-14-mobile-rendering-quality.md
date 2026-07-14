# Mobile Rendering Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve APK and weak-mobile rendering with anti-aliased pre-bloom edges and stable world lighting while preserving the current 30 FPS mobile cadence.

**Architecture:** Keep the existing quality-tier boundary and change only the low tier's composer sample count from zero to two. Separate decorative lamp fixture flicker from world illumination through a pure distance-and-mode helper used by the road-light update, leaving the existing lamp recycling and cross-fade system intact.

**Tech Stack:** TypeScript 5.5, Three.js 0.169, EffectComposer, UnrealBloomPass, Vitest 2.1, Vite 5.4, Capacitor 8, Android Gradle

## Global Constraints

- Preserve low-tier `frameCapFps: 30`.
- Preserve low-tier `pixelRatioCap: 1.25`.
- Preserve low-tier `bloom: true` and `bloomScale: 0.5`.
- Preserve low-tier `detail: "reduced"`.
- Set low-tier `postSamples: 2`; keep high-tier `postSamples: 4`.
- Dying lamps may flicker only their fixture objects. They must not toggle real point-light illumination.
- Dead lamps must remain excluded from real point-light illumination.
- Do not change the high rendering tier, gameplay, camera motion, market-shock effects, or intentional end-of-round UI flashes.
- Add no dependency, graphics menu, dynamic quality switch, native Android change, or Capacitor configuration change.
- Do not use em dashes in code comments, tests, documentation, or commit messages.

---

### Task 1: Enable mobile composer multisampling

**Files:**
- Modify: `redline3d/src/platform/perf.test.ts:30-41,98-109`
- Modify: `redline3d/src/platform/perf.ts:73-85`

**Interfaces:**
- Consumes: `detectQuality(signals?: QualitySignals): Quality`
- Produces: low-tier `Quality` values with `postSamples: 2`; the existing `main.ts` call to `createPost(..., quality.postSamples)` consumes the value without an interface change.

- [ ] **Step 1: Write the failing low-tier expectations**

In `redline3d/src/platform/perf.test.ts`, replace the low-tier sample assertions and descriptions so both the ordinary low tier and masked Android fallback require two samples:

```ts
test("low tier keeps the authored look with 2x pre-bloom MSAA and a 30fps cap", () => {
  const q = detectQuality({ nav: weakNav });
  expect(q.bloom).toBe(true);
  expect(q.bloomScale).toBe(0.5);
  expect(q.postSamples).toBe(2);
  expect(q.pixelRatioCap).toBe(1.25);
  expect(q.detail).toBe("reduced");
  expect(q.frameCapFps).toBe(30);
});
```

In the existing `no renderer string + Android UA` test, change only the sample assertion:

```ts
expect(q.postSamples).toBe(2);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd redline3d
npm test -- src/platform/perf.test.ts
```

Expected: FAIL because the low tier returns `postSamples: 0`, with assertions receiving `0` where `2` is expected.

- [ ] **Step 3: Set the low tier to two composer samples**

In `redline3d/src/platform/perf.ts`, keep every other profile value unchanged and update the low branch:

```ts
low
  ? { tier: "low", bloom: true, bloomScale: 0.5, pixelRatioCap: 1.25, detail: "reduced", frameCapFps: 30, postSamples: 2 }
  : { tier: "high", bloom: true, bloomScale: 1, pixelRatioCap: 2, detail: "full", postSamples: 4 };
```

Update the adjacent comments and the `Quality.postSamples` documentation to state that the low tier uses 2x pre-bloom multisampling and the high tier uses 4x. Remove claims that mobile aliasing is invisible or that the low tier disables composer MSAA.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd redline3d
npm test -- src/platform/perf.test.ts
```

Expected: PASS with all tests in `src/platform/perf.test.ts` passing.

- [ ] **Step 5: Commit the quality-profile change**

```bash
git add redline3d/src/platform/perf.ts redline3d/src/platform/perf.test.ts
git commit -m "fix: add mobile pre-bloom multisampling"
```

---

### Task 2: Keep lamp flicker local to fixtures

**Files:**
- Create: `redline3d/src/render/world-light.test.ts`
- Modify: `redline3d/src/render/world.ts:625-750`

**Interfaces:**
- Produces: `export type LampMode = 0 | 1 | 2`
- Produces: `lampWorldLightFactor(mode: LampMode, distanceFromCar: number): number`
- Behavior: returns zero for dead mode `1`; for normal mode `0` and dying mode `2`, returns the squared clamped fade factor `max(0, 1 - abs(distanceFromCar) / 64) ** 2`.

- [ ] **Step 1: Write the failing lamp-light regression test**

Create `redline3d/src/render/world-light.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { lampWorldLightFactor } from "./world";

describe("lampWorldLightFactor", () => {
  test("dying fixture mode keeps the same world illumination as a normal lamp", () => {
    expect(lampWorldLightFactor(2, 0)).toBe(1);
    expect(lampWorldLightFactor(2, 32)).toBeCloseTo(0.25);
    expect(lampWorldLightFactor(2, 0)).toBe(lampWorldLightFactor(0, 0));
  });

  test("dead lamps stay dark and distance still fades live lamps", () => {
    expect(lampWorldLightFactor(1, 0)).toBe(0);
    expect(lampWorldLightFactor(0, 64)).toBe(0);
    expect(lampWorldLightFactor(2, 96)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd redline3d
npm test -- src/render/world-light.test.ts
```

Expected: FAIL because `./world` does not export `lampWorldLightFactor`.

- [ ] **Step 3: Add the pure world-light factor**

Near the lamp constants in `redline3d/src/render/world.ts`, add:

```ts
export type LampMode = 0 | 1 | 2;

const REAL_LIGHT_FADE_DISTANCE = 64;

export function lampWorldLightFactor(mode: LampMode, distanceFromCar: number): number {
  if (mode === 1) return 0;
  const t = Math.max(0, 1 - Math.abs(distanceFromCar) / REAL_LIGHT_FADE_DISTANCE);
  return t * t;
}
```

Change the internal lamp type to use the exported mode:

```ts
type Lamp = { o: THREE.Group; lights: THREE.Object3D[]; mode: LampMode; seed: number; side: number };
```

Change the mode variable in `buildLamps` to use `LampMode`:

```ts
const mode: LampMode = r < 1 / 50 ? 1 : r < 1 / 50 + 1 / 43 ? 2 : 0;
```

- [ ] **Step 4: Decouple real point lights from fixture visibility**

In `setLight`, remove the read of `l.lights[1].visible` and calculate the target from the pure helper:

```ts
const factor = lampWorldLightFactor(l.mode, l.o.position.z - CAR_Z);
target = factor * REAL_I * marketShockLightBoost(shockAmount);
```

Keep the existing point-light position, theme color, market-shock tint, reassignment snap, same-lamp interpolation, dead-lamp exclusion in the scratch arrays, lamp recycling, and dying fixture visibility loop unchanged.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
cd redline3d
npm test -- src/render/world-light.test.ts src/platform/perf.test.ts
```

Expected: PASS with all tests in both files passing.

- [ ] **Step 6: Run complete automated verification**

Run:

```bash
cd redline3d
npm test
npm run build
npm run apk
```

Expected: Vitest reports zero failed test files and zero failed tests, Vite production build exits 0, and the Android Gradle build exits 0 with an APK produced by the existing build script.

- [ ] **Step 7: Commit the stable-lighting change**

```bash
git add redline3d/src/render/world.ts redline3d/src/render/world-light.test.ts
git commit -m "fix: keep mobile lamp illumination stable"
```

---

## Final Visual Verification

Use the existing development hooks and FPS meter after both tasks are committed:

1. Start the game with `cd redline3d && VITE_PERF=low VITE_FPS=1 npm run dev`.
2. Open the play surface at a phone viewport.
3. Enter the race road and drive past enough lamps to observe at least one dying fixture.
4. Confirm the fixture itself still flickers while the car, road, and overall frame brightness remain continuous.
5. Confirm high-contrast neon edges no longer show the previous un-antialiased shimmer under bloom.
6. On a physical Seeker, install the newly built APK and confirm the FPS meter continues presenting at the existing 30 FPS cap.
