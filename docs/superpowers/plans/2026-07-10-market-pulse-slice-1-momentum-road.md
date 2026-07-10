# Market Pulse Slice 1: Momentum Road Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add asset-neutral Market Pulse signals and make the Redline race road climb or descend with sustained price momentum.

**Architecture:** A pure `core/market-pulse.ts` module owns price observation, smoothing, shock bookkeeping, and liquidation danger without touching settlement. A second pure `core/market-road.ts` module maps smoothed price displacement plus normalized momentum to the existing World hill-bias input. `main.ts` only composes these modules and exposes a development-only momentum override for deterministic browser review.

**Tech Stack:** TypeScript, Vitest, Three.js, Vite, existing `RoundEngine`, existing `World.update(dt, speed, bias)` interface.

## Global Constraints

- Settlement, leverage, liquidation thresholds, steering limits, collisions, and on-chain instructions must remain unchanged.
- Use percentage returns so BTC, ETH, and SOL produce equal signals for equal percentage movement.
- Ignore repeated and non-positive price observations.
- A stale feed must decay momentum and volatility and suppress new shocks.
- The existing terrain bias remains clamped to `-7..7`.
- Existing displacement contributes `45%`; momentum contributes at most `5.5` world units.
- Development overrides must be inside `import.meta.env.DEV` diagnostics and absent from production behavior.
- Every task runs its targeted tests, the full client suite, and the client build before commit.
- Stop after Task 2 for user play review. Do not implement shockwave, volatility road pressure, or liquidation deterioration in this plan.

---

## File structure

- Create `redline3d/src/core/market-pulse.ts`: stateful conversion from market observations to normalized pulse signals.
- Create `redline3d/src/core/market-pulse.test.ts`: deterministic signal, decay, shock, danger, and reset tests.
- Create `redline3d/src/core/market-road.ts`: pure mapping from price displacement and momentum to terrain bias.
- Create `redline3d/src/core/market-road.test.ts`: terrain direction, blend, and clamp tests.
- Modify `redline3d/src/main.ts`: observe prices, reset on asset switch, drive the existing World hill bias, and expose the development probe.

### Task 1: Market Pulse signal model

**Files:**
- Create: `redline3d/src/core/market-pulse.ts`
- Create: `redline3d/src/core/market-pulse.test.ts`

**Interfaces:**
- Consumes: `{ price, live, roundLive, buffer, dt }` once per rendered race frame.
- Produces: `createMarketPulse(): MarketPulse`, `CALM_MARKET_PULSE`, `MarketPulseFrame`, and `MarketPulseInput`.
- `MarketPulse.update(input)` returns `{ volatility, momentum, shock, shockId, danger }`.
- `MarketPulse.reset()` clears asset-specific observation state.

- [ ] **Step 1: Write the failing Market Pulse tests**

Create `redline3d/src/core/market-pulse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMarketPulse } from "./market-pulse";

const input = (price: number, extra: Partial<{
  live: boolean;
  roundLive: boolean;
  buffer: number;
  dt: number;
}> = {}) => ({
  price,
  live: true,
  roundLive: false,
  buffer: 1,
  dt: 0.2,
  ...extra,
});

function trend(start: number, factor: number, count = 20) {
  const pulse = createMarketPulse();
  let price = start;
  pulse.update(input(price));
  let frame = pulse.update(input(price));
  for (let i = 0; i < count; i++) {
    price *= factor;
    frame = pulse.update(input(price));
  }
  return frame;
}

describe("Market Pulse", () => {
  it("keeps a flat price calm", () => {
    const pulse = createMarketPulse();
    for (let i = 0; i < 30; i++) pulse.update(input(100));
    expect(pulse.update(input(100)).volatility).toBe(0);
    expect(pulse.update(input(100)).momentum).toBe(0);
  });

  it("turns sustained upward and downward movement into signed momentum", () => {
    expect(trend(100, 1.0004).momentum).toBeGreaterThan(0.15);
    expect(trend(100, 0.9996).momentum).toBeLessThan(-0.15);
  });

  it("keeps percentage behavior independent of asset price", () => {
    const low = trend(100, 1.0004);
    const high = trend(100_000, 1.0004);
    expect(high.momentum).toBeCloseTo(low.momentum, 8);
    expect(high.volatility).toBeCloseTo(low.volatility, 8);
  });

  it("can be volatile without holding directional momentum", () => {
    const pulse = createMarketPulse();
    let price = 100;
    pulse.update(input(price));
    let frame = pulse.update(input(price));
    for (let i = 0; i < 30; i++) {
      price *= i % 2 === 0 ? 1.0004 : 1 / 1.0004;
      frame = pulse.update(input(price));
    }
    expect(frame.volatility).toBeGreaterThan(0.1);
    expect(Math.abs(frame.momentum)).toBeLessThan(0.08);
  });

  it("triggers one shock and respects the cooldown", () => {
    const pulse = createMarketPulse();
    pulse.update(input(100));
    const first = pulse.update(input(100.2));
    const repeated = pulse.update(input(100.4));
    expect(first.shockId).toBe(1);
    expect(first.shock).toBeGreaterThan(0);
    expect(repeated.shockId).toBe(1);
  });

  it("decays market movement when the feed is stale", () => {
    const pulse = createMarketPulse();
    let price = 100;
    pulse.update(input(price));
    for (let i = 0; i < 20; i++) {
      price *= 1.0004;
      pulse.update(input(price));
    }
    let frame = pulse.update(input(price));
    expect(frame.momentum).toBeGreaterThan(0.15);
    for (let i = 0; i < 30; i++) {
      frame = pulse.update(input(price, { live: false, dt: 0.1 }));
    }
    expect(Math.abs(frame.momentum)).toBeLessThan(0.02);
    expect(frame.volatility).toBeLessThan(0.02);
  });

  it("derives danger only from a live Round below 35% buffer", () => {
    const pulse = createMarketPulse();
    const safe = pulse.update(input(100, { roundLive: true, buffer: 0.35, dt: 0.1 }));
    let danger = safe;
    for (let i = 0; i < 10; i++) {
      danger = pulse.update(input(100, { roundLive: true, buffer: 0, dt: 0.1 }));
    }
    let idle = danger;
    for (let i = 0; i < 10; i++) {
      idle = pulse.update(input(100, { roundLive: false, buffer: 0, dt: 0.1 }));
    }
    expect(safe.danger).toBe(0);
    expect(danger.danger).toBeGreaterThan(0.95);
    expect(idle.danger).toBeLessThan(0.05);
  });

  it("reset clears asset-specific observations", () => {
    const pulse = createMarketPulse();
    pulse.update(input(100));
    pulse.update(input(100.2));
    pulse.reset();
    const frame = pulse.update(input(50_000));
    expect(frame).toEqual({ volatility: 0, momentum: 0, shock: 0, shockId: 0, danger: 0 });
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm test --prefix redline3d -- src/core/market-pulse.test.ts
```

Expected: FAIL because `./market-pulse` does not exist.

- [ ] **Step 3: Implement the Market Pulse module**

Create `redline3d/src/core/market-pulse.ts`:

```ts
export interface MarketPulseFrame {
  volatility: number;
  momentum: number;
  shock: number;
  shockId: number;
  danger: number;
}

export interface MarketPulseInput {
  price: number;
  live: boolean;
  roundLive: boolean;
  buffer: number;
  dt: number;
}

export interface MarketPulse {
  update(input: MarketPulseInput): MarketPulseFrame;
  reset(): void;
}

export const CALM_MARKET_PULSE: Readonly<MarketPulseFrame> = Object.freeze({
  volatility: 0,
  momentum: 0,
  shock: 0,
  shockId: 0,
  danger: 0,
});

const VOL_CALM = 0.0001;
const VOL_FULL = 0.0012;
const MOMENTUM_FULL = 0.0015;
const SHOCK_MIN = 0.0008;
const SHOCK_COOLDOWN = 1;
const VOL_TAU = 0.7;
const MOMENTUM_TAU = 2;
const STALE_TAU = 0.6;
const SHOCK_TAU = 0.25;
const DANGER_TAU = 0.12;

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const ease = (current: number, target: number, dt: number, tau: number) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));
const normalize = (v: number, lo: number, hi: number) => clamp((v - lo) / (hi - lo));
const smoothstep = (v: number) => {
  const x = clamp(v);
  return x * x * (3 - 2 * x);
};

export function createMarketPulse(): MarketPulse {
  let lastPrice = 0;
  let sinceObservation = 0;
  let volatilityEwma = 0;
  let momentumEwma = 0;
  let shock = 0;
  let shockId = 0;
  let shockCooldown = 0;
  let danger = 0;

  const reset = () => {
    lastPrice = 0;
    sinceObservation = 0;
    volatilityEwma = 0;
    momentumEwma = 0;
    shock = 0;
    shockId = 0;
    shockCooldown = 0;
    danger = 0;
  };

  return {
    reset,
    update(input) {
      const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, 0.1);
      sinceObservation += dt;
      shockCooldown = Math.max(0, shockCooldown - dt);
      shock = ease(shock, 0, dt, SHOCK_TAU);

      if (!input.live) {
        volatilityEwma = ease(volatilityEwma, 0, dt, STALE_TAU);
        momentumEwma = ease(momentumEwma, 0, dt, STALE_TAU);
      } else if (input.price > 0 && input.price !== lastPrice) {
        if (lastPrice > 0) {
          const change = input.price / lastPrice - 1;
          const magnitude = Math.abs(change);
          const observationDt = Math.max(0.016, sinceObservation);
          const previousVolatility = volatilityEwma;
          volatilityEwma = ease(volatilityEwma, magnitude, observationDt, VOL_TAU);
          momentumEwma = ease(momentumEwma, change, observationDt, MOMENTUM_TAU);
          const shockThreshold = Math.max(SHOCK_MIN, 2.5 * Math.max(previousVolatility, 0.00002));
          if (magnitude >= shockThreshold && shockCooldown === 0) {
            shockId += 1;
            shock = clamp(0.4 + (magnitude - shockThreshold) / 0.0026, 0.4, 1);
            shockCooldown = SHOCK_COOLDOWN;
          }
        }
        lastPrice = input.price;
        sinceObservation = 0;
      }

      const dangerTarget = input.roundLive
        ? smoothstep((0.35 - clamp(input.buffer, 0, 1)) / 0.35)
        : 0;
      danger = ease(danger, dangerTarget, dt, DANGER_TAU);

      return {
        volatility: normalize(volatilityEwma, VOL_CALM, VOL_FULL),
        momentum: clamp(momentumEwma / MOMENTUM_FULL, -1, 1),
        shock,
        shockId,
        danger,
      };
    },
  };
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npm test --prefix redline3d -- src/core/market-pulse.test.ts
```

Expected: `1` test file passes with `8` passing tests.

- [ ] **Step 5: Run full verification for the commit**

Run:

```bash
npm test --prefix redline3d
npm run build --prefix redline3d
```

Expected: all non-devnet client tests pass; devnet tests remain skipped without `RAIDER_DEVNET=1`; TypeScript and Vite build exit `0`.

- [ ] **Step 6: Commit the signal model**

```bash
git add redline3d/src/core/market-pulse.ts redline3d/src/core/market-pulse.test.ts
git commit -m "feat(client): add market pulse signal model"
```

### Task 2: Momentum-responsive race road

**Files:**
- Create: `redline3d/src/core/market-road.ts`
- Create: `redline3d/src/core/market-road.test.ts`
- Modify: `redline3d/src/main.ts:18-24, 807-842, 1242-1582, 1739-1762`

**Interfaces:**
- Consumes: `MarketPulseFrame.momentum`, `solSmooth`, and `solEMA`.
- Produces: `terrainBias(input: TerrainBiasInput): number` clamped to `-7..7`.
- Development probe: `window.__marketPulse.momentum(value)` forces `-1..1`; calling it with no value returns to the live signal.

- [ ] **Step 1: Write the failing terrain mapping tests**

Create `redline3d/src/core/market-road.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { terrainBias } from "./market-road";

describe("terrainBias", () => {
  it("climbs on positive momentum and descends on negative momentum", () => {
    expect(terrainBias({ smoothPrice: 100, emaPrice: 100, momentum: 1 })).toBe(5.5);
    expect(terrainBias({ smoothPrice: 100, emaPrice: 100, momentum: -1 })).toBe(-5.5);
  });

  it("keeps 45% of the existing price-displacement terrain response", () => {
    expect(terrainBias({ smoothPrice: 100.1, emaPrice: 100, momentum: 0 })).toBeCloseTo(1.17, 8);
  });

  it("blends displacement and momentum", () => {
    expect(terrainBias({ smoothPrice: 100.1, emaPrice: 100, momentum: 0.5 })).toBeCloseTo(3.92, 8);
  });

  it("clamps the combined response to the existing world range", () => {
    expect(terrainBias({ smoothPrice: 102, emaPrice: 100, momentum: 1 })).toBe(7);
    expect(terrainBias({ smoothPrice: 98, emaPrice: 100, momentum: -1 })).toBe(-7);
  });

  it("uses momentum safely before the slow average exists", () => {
    expect(terrainBias({ smoothPrice: 0, emaPrice: 0, momentum: 0.5 })).toBe(2.75);
  });
});
```

- [ ] **Step 2: Run the terrain test to verify RED**

Run:

```bash
npm test --prefix redline3d -- src/core/market-road.test.ts
```

Expected: FAIL because `./market-road` does not exist.

- [ ] **Step 3: Implement the pure terrain mapping**

Create `redline3d/src/core/market-road.ts`:

```ts
export interface TerrainBiasInput {
  smoothPrice: number;
  emaPrice: number;
  momentum: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function terrainBias(input: TerrainBiasInput): number {
  const displacement = input.smoothPrice > 0 && input.emaPrice > 0
    ? clamp((input.smoothPrice / input.emaPrice - 1) * 2600, -7, 7) * 0.45
    : 0;
  const momentum = clamp(input.momentum, -1, 1) * 5.5;
  return clamp(displacement + momentum, -7, 7);
}
```

- [ ] **Step 4: Run the terrain test to verify GREEN**

Run:

```bash
npm test --prefix redline3d -- src/core/market-road.test.ts
```

Expected: `1` test file passes with `5` passing tests.

- [ ] **Step 5: Wire Market Pulse into the race frame**

Modify `redline3d/src/main.ts`.

Add imports beside the existing core imports:

```ts
import { CALM_MARKET_PULSE, createMarketPulse, type MarketPulseFrame } from "./core/market-pulse";
import { terrainBias } from "./core/market-road";
```

Add state beside `solSmooth` and `solEMA`:

```ts
const marketPulse = createMarketPulse();
let marketFrame: MarketPulseFrame = { ...CALM_MARKET_PULSE };
let debugMomentum: number | null = null;
```

Reset Market Pulse inside the existing asset-change callback after clearing `priceHist`:

```ts
marketPulse.reset();
marketFrame = { ...CALM_MARKET_PULSE };
debugMomentum = null;
```

At the start of the race branch after `const drivable = engine.getPhase() === "live"`, declare the current visual buffer:

```ts
let liveBuffer = 1;
```

Inside the existing live snapshot branch, after confirming `snap.phase === "live"`, assign:

```ts
liveBuffer = snap.buffer;
```

Replace the existing inline `hill` calculation immediately before `world.update(...)` with:

```ts
marketFrame = marketPulse.update({
  price: roundPrice,
  live: priceSource.live(),
  roundLive: drivable,
  buffer: liveBuffer,
  dt,
});
const hill = terrainBias({
  smoothPrice: solSmooth,
  emaPrice: solEMA,
  momentum: debugMomentum ?? marketFrame.momentum,
});
```

Keep the existing call unchanged:

```ts
world.update(dt, speed, hill);
```

Inside the existing `if (import.meta.env.DEV)` block, add:

```ts
(window as any).__marketPulse = {
  state: () => ({ ...marketFrame, momentumOverride: debugMomentum }),
  momentum: (value?: number) => {
    debugMomentum = value === undefined
      ? null
      : Math.max(-1, Math.min(1, Number(value) || 0));
  },
};
```

- [ ] **Step 6: Run focused and full automated verification**

Run:

```bash
npm test --prefix redline3d -- src/core/market-pulse.test.ts src/core/market-road.test.ts
npm test --prefix redline3d
npm run build --prefix redline3d
```

Expected: `13` focused tests pass; all non-devnet client tests pass; TypeScript and Vite build exit `0`.

- [ ] **Step 7: Verify the road response in the browser**

Start the client:

```bash
npm run dev --prefix redline3d -- --host 127.0.0.1
```

In the development browser console:

```js
__marketPulse.momentum(1)
__marketPulse.state()
__marketPulse.momentum(-1)
__marketPulse.state()
__marketPulse.momentum()
```

Expected:

- `1` creates a smooth sustained climb.
- `-1` creates a smooth sustained descent.
- No argument returns control to the live Market Pulse signal.
- Car pitch follows the existing road surface without floating.
- The road never exceeds the existing `-7..7` bias behavior.
- No console errors appear.
- Lobby, Garage, and Strip behavior remain unchanged.

- [ ] **Step 8: Commit the momentum road slice**

```bash
git add redline3d/src/core/market-road.ts redline3d/src/core/market-road.test.ts redline3d/src/main.ts
git commit -m "feat(client): drive terrain pitch from market momentum"
```

- [ ] **Step 9: Stop for user play review**

Report both commit hashes and the exact development controls. Do not begin shockwave or camera-shake work until the user accepts the momentum road or asks for a revision/revert.
