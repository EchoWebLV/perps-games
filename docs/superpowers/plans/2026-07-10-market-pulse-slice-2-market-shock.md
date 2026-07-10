# Market Pulse Slice 2: Sudden-Move Shock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each accepted sudden market move produce one directional road shockwave, one short world-light pulse, and one camera impulse.

**Architecture:** Extend the pure Market Pulse frame with the direction of the accepted shock. A focused `market-shock` renderer owns event de-duplication, the expanding ring, effect decay, and reduced-motion behavior. `main.ts` passes the normalized signal to the renderer, while the existing World and chase camera receive visual-only pulse values.

**Tech Stack:** TypeScript, Three.js, Vitest, Vite

## Global Constraints

- The effect is visual only and must never feed the Round engine, settlement, leverage, steering, collision, or cash-out logic.
- One accepted `shockId` produces exactly one visual event.
- Upward shocks use green-cyan; downward shocks use red-magenta.
- Reduced motion disables camera shake but keeps the ring and world pulse.
- Leaving a live Round clears the active visual and synchronizes the last seen `shockId` so an old event cannot replay.
- Full and reduced detail use a bounded object count with no per-frame mesh creation.
- Commit this slice independently before starting volatility road pressure.

---

### Task 1: Directional market shock renderer and integration

**Files:**
- Modify: `redline3d/src/core/market-pulse.ts`
- Modify: `redline3d/src/core/market-pulse.test.ts`
- Create: `redline3d/src/render/market-shock.ts`
- Create: `redline3d/src/render/market-shock.test.ts`
- Modify: `redline3d/src/render/world.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `MarketPulseFrame.shock`, `MarketPulseFrame.shockId`, `MarketPulseFrame.shockDirection`, Round liveness, `World.surfaceY`, `ChaseCam.shake`.
- Produces: `createMarketShock(options)`, whose result exposes `group`, `update(input, dt)`, and `reset(shockId)`.
- Produces: `World.setMarketShock(amount, direction)` for the road-grid and lamp pulse.

- [ ] **Step 1: Write failing Market Pulse direction tests**

Extend the accepted-shock test in `redline3d/src/core/market-pulse.test.ts`:

```ts
it("records the signed direction of each accepted shock", () => {
  const up = createMarketPulse();
  up.update(input(100));
  expect(up.update(input(100.2)).shockDirection).toBe(1);

  const down = createMarketPulse();
  down.update(input(100));
  expect(down.update(input(99.8)).shockDirection).toBe(-1);
});
```

Update the reset expectation so the calm frame includes `shockDirection: 0`.

- [ ] **Step 2: Write failing renderer-core tests**

Create `redline3d/src/render/market-shock.test.ts` with tests for one-shot triggering, direction, decay, inactive-round synchronization, and reduced motion:

```ts
import { describe, expect, it } from "vitest";
import { createMarketShockCore } from "./market-shock";

describe("Market shock core", () => {
  it("triggers once for a new shock id and then decays", () => {
    const core = createMarketShockCore();
    core.update({ active: false, shockId: 0, strength: 0, direction: 0, reducedMotion: false }, 0.016);
    const first = core.update({ active: true, shockId: 1, strength: 0.8, direction: 1, reducedMotion: false }, 0.016);
    const repeated = core.update({ active: true, shockId: 1, strength: 0.8, direction: 1, reducedMotion: false }, 0.016);

    expect(first.triggered).toBe(true);
    expect(first.cameraImpulse).toBeGreaterThan(0);
    expect(first.direction).toBe(1);
    expect(repeated.triggered).toBe(false);
    expect(repeated.cameraImpulse).toBe(0);
  });

  it("keeps the visual but suppresses camera impulse for reduced motion", () => {
    const core = createMarketShockCore();
    const frame = core.update({ active: true, shockId: 1, strength: 1, direction: -1, reducedMotion: true }, 0.016);

    expect(frame.active).toBe(true);
    expect(frame.flash).toBeGreaterThan(0);
    expect(frame.cameraImpulse).toBe(0);
  });

  it("does not replay a shock that occurred outside a live round", () => {
    const core = createMarketShockCore();
    core.update({ active: false, shockId: 4, strength: 1, direction: 1, reducedMotion: false }, 0.016);
    const frame = core.update({ active: true, shockId: 4, strength: 1, direction: 1, reducedMotion: false }, 0.016);

    expect(frame.triggered).toBe(false);
    expect(frame.active).toBe(false);
  });
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
cd redline3d
npm test -- --run src/core/market-pulse.test.ts src/render/market-shock.test.ts
```

Expected: FAIL because `shockDirection` and `createMarketShockCore` do not exist.

- [ ] **Step 4: Add shock direction to the signal frame**

In `redline3d/src/core/market-pulse.ts`:

```ts
export type MarketDirection = -1 | 0 | 1;

export interface MarketPulseFrame {
  volatility: number;
  momentum: number;
  shock: number;
  shockId: number;
  shockDirection: MarketDirection;
  danger: number;
}
```

Store `shockDirection` inside `createMarketPulse()`. Set it to `Math.sign(change) as -1 | 1` only when a shock is accepted, expose it in every frame, and reset it to `0`.

- [ ] **Step 5: Implement the pure shock lifecycle and renderer**

Create `redline3d/src/render/market-shock.ts` with:

```ts
import * as THREE from "three";
import type { MarketDirection } from "../core/market-pulse";

export interface MarketShockCoreInput {
  active: boolean;
  shockId: number;
  strength: number;
  direction: MarketDirection;
  reducedMotion: boolean;
}

export interface MarketShockCoreFrame {
  active: boolean;
  triggered: boolean;
  progress: number;
  flash: number;
  cameraImpulse: number;
  direction: MarketDirection;
}

export function createMarketShockCore(): {
  update(input: MarketShockCoreInput, dt: number): MarketShockCoreFrame;
  reset(shockId?: number): void;
} {
  const duration = 0.75;
  let seenId = 0;
  let age = duration;
  let strength = 0;
  let direction: MarketDirection = 0;

  const idle = (): MarketShockCoreFrame => ({
    active: false, triggered: false, progress: 1, flash: 0, cameraImpulse: 0, direction,
  });

  return {
    reset(shockId = 0) {
      seenId = shockId;
      age = duration;
      strength = 0;
      direction = 0;
    },
    update(input, rawDt) {
      const dt = Math.max(0, Math.min(0.1, Number.isFinite(rawDt) ? rawDt : 0));
      if (!input.active) {
        seenId = input.shockId;
        age = duration;
        strength = 0;
        direction = 0;
        return idle();
      }

      let triggered = false;
      let cameraImpulse = 0;
      if (input.shockId > seenId) {
        seenId = input.shockId;
        age = 0;
        strength = Math.max(0, Math.min(1, input.strength));
        direction = input.direction < 0 ? -1 : input.direction > 0 ? 1 : 0;
        triggered = true;
        if (!input.reducedMotion) cameraImpulse = 0.25 + strength * 0.55;
      }

      if (age >= duration) return idle();
      age = Math.min(duration, age + dt);
      const progress = age / duration;
      return {
        active: progress < 1,
        triggered,
        progress,
        flash: strength * (1 - progress) * (1 - progress),
        cameraImpulse,
        direction,
      };
    },
  };
}

export function marketShockColor(direction: MarketDirection): string {
  return direction < 0 ? "#ff326f" : "#2effc5";
}

export interface MarketShockOptions {
  detail: "full" | "reduced";
  reducedMotion: boolean;
  surfaceY(worldZ: number): number;
  onWorldPulse(amount: number, direction: MarketDirection): void;
  onCameraShake(amount: number): void;
}

export interface MarketShockUpdate {
  active: boolean;
  shockId: number;
  strength: number;
  direction: MarketDirection;
}

export function createMarketShock(options: MarketShockOptions) {
  const core = createMarketShockCore();
  const group = new THREE.Group();
  const geometry = new THREE.RingGeometry(0.82, 1, 64);
  const makeRing = (opacity: number) => {
    const material = new THREE.MeshBasicMaterial({
      color: marketShockColor(1), transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
    return { mesh, material };
  };
  const rings = [makeRing(0.9)];
  if (options.detail === "full") rings.push(makeRing(0.42));
  group.visible = false;

  return {
    group,
    reset(shockId = 0) {
      core.reset(shockId);
      group.visible = false;
      options.onWorldPulse(0, 0);
    },
    update(input: MarketShockUpdate, dt: number) {
      const frame = core.update({ ...input, reducedMotion: options.reducedMotion }, dt);
      if (frame.cameraImpulse > 0) options.onCameraShake(frame.cameraImpulse);
      options.onWorldPulse(frame.flash, frame.direction);
      group.visible = frame.active;
      if (!frame.active) return frame;

      const travel = frame.progress * frame.progress * (3 - 2 * frame.progress);
      const z = -150 + 138 * travel;
      const scale = 10 + 40 * frame.progress;
      const color = marketShockColor(frame.direction);
      rings.forEach((ring, index) => {
        ring.mesh.position.set(0, options.surfaceY(z) + 0.16 + index * 0.03, z);
        ring.mesh.scale.setScalar(scale * (1 + index * 0.12));
        ring.material.color.set(color);
        ring.material.opacity = frame.flash * (index === 0 ? 0.9 : 0.42);
      });
      return frame;
    },
  };
}
```

The full-detail renderer uses a second, fainter echo ring. Reduced detail uses one ring. Both variants allocate their fixed meshes only at construction time.

- [ ] **Step 6: Add the world pulse consumer**

Extend `World` in `redline3d/src/render/world.ts`:

```ts
setMarketShock(amount: number, direction: -1 | 0 | 1): void;
```

Add bounded `uShock` and `uShockColor` uniforms to both persistent road materials. Mix the directional color into the road edge and grid emission, and multiply the nearest roadside point-light target by a capped pulse factor. Do not add or remove lights at runtime.

```ts
let shockAmount = 0;
const shockColor = new THREE.Color("#2effc5");

setMarketShock(amount, direction) {
  shockAmount = Math.max(0, Math.min(1, amount));
  shockColor.set(direction < 0 ? "#ff326f" : "#2effc5");
}
```

Each `update` copies `shockAmount` and `shockColor` into the two shader uniform sets. The grid fragment mixes its line color toward `uShockColor` by `uShock * 0.72`. The road fragment adds `uShockColor * uShock * (0.35 + edges * 0.75)` to its existing color. The real point-light target multiplies by `1 + shockAmount * 1.8`, capped by the existing light assignment and count.

- [ ] **Step 7: Wire the renderer into race mode**

In `redline3d/src/main.ts`, construct the effect after `world` and `chase` exist:

```ts
const marketShock = createMarketShock({
  detail: quality.detail,
  reducedMotion: matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  surfaceY: world.surfaceY,
  onWorldPulse: (amount, direction) => world.setMarketShock(amount, direction),
  onCameraShake: (amount) => chase.shake(amount),
});
ctx.scene.add(marketShock.group);
```

Feed it after `marketPulse.update` and before `world.update`:

```ts
marketShock.update({
  active: drivable,
  shockId: marketFrame.shockId,
  strength: marketFrame.shock,
  direction: marketFrame.shockDirection,
}, dt);
```

Reset and hide it when entering the Strip, and show it when entering race mode. Extend the development probe with a `shock(direction, strength)` trigger that increments a debug shock id without changing Round state.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
cd redline3d
npm test -- --run src/core/market-pulse.test.ts src/render/market-shock.test.ts
```

Expected: both files PASS.

- [ ] **Step 9: Verify the complete slice**

Run:

```bash
cd redline3d
npm test -- --reporter=dot
npm run build
```

In the local browser, force one positive and one negative shock through the development probe. Verify the directional ring, one camera impulse per id, no replay after the Round ends, reduced-motion suppression, and no console errors.

- [ ] **Step 10: Commit the slice**

```bash
git add redline3d/src/core/market-pulse.ts \
  redline3d/src/core/market-pulse.test.ts \
  redline3d/src/render/market-shock.ts \
  redline3d/src/render/market-shock.test.ts \
  redline3d/src/render/world.ts \
  redline3d/src/main.ts
git commit -m "feat(client): add sudden-move market shock and shake"
```

Stop after this commit for hands-on review. Do not start volatility road pressure.
