# MagicBlock-Native Highway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a SOL-only, currency-ready Highway where vault-backed MagicBlock ER positions remain open until cash-out or liquidation, leverage is selectable from 10x to 250x, and live long and short cars drive automatically on opposite carriageways.

**Architecture:** Keep Track and its timed Round behavior unchanged. Add a currency boundary in the client, encode open-ended Highway rounds with a unique negative `deadline_ts`, accrue a fixed borrow fee lazily in shared settlement math, and reuse the existing ER delegation and scheduler. Replace Highway manual controls with pure automatic-lap motion plus a slider, then extend the existing presence channel with wallet-bound Highway advertisements that clients verify against Round accounts.

**Tech Stack:** Rust and Anchor 0.32.1, MagicBlock Ephemeral Rollups and scheduled cranks, TypeScript, Vite, Vitest, Three.js, Fastify, WebSocket, Zod, Solana web3.js.

## Global Constraints

- Work only on `codex/magicblock-native-highway`; do not modify `main`.
- Track remains timed and behavior-compatible with the current test suite.
- SOL is the only enabled stake currency; the stake mint remains wrapped SOL with 9 decimals.
- Highway leverage is 10x through 250x in 10x steps.
- Highway positions use a unique negative `deadline_ts`; positive deadlines remain Track timers and zero remains idle.
- Borrowing fee is 1 basis point of notional per 24 hours, accrued without hourly transactions.
- Highway schedules one-second terminal checks for 24 hours and ensures non-overlapping coverage on reconnect.
- No Flash Trade, USDC toggle, public LP pool, steering, throttle, or collisions.
- Public Highway cars must represent wallet-backed live positions; practice cars remain local-only.
- Use test-first development and commit after every task.
- Do not use em dashes in new copy or comments.

---

## File Structure

### New files

- `redline3d/src/core/stake-currency.ts`: currency metadata, unit conversion, and formatting.
- `redline3d/src/core/stake-currency.test.ts`: SOL registry and conversion tests.
- `redline3d/src/core/highway-auto.ts`: pure leverage, speed, lane, and automatic oval motion.
- `redline3d/src/core/highway-auto.test.ts`: deterministic long and short motion tests.
- `redline3d/src/ui/highway-controls.ts`: 10x to 250x slider and syncing state.
- `redline3d/src/ui/highway-controls.test.ts`: slider interaction tests.
- `redline3d/src/chain/highway-verifier.ts`: derive and verify advertised remote Round accounts.
- `redline3d/src/chain/highway-verifier.test.ts`: verification tests with injected account reads.

### Modified files

- `onchain/raider/programs/raider/src/state.rs`: Highway duration sentinel and negative marker helper.
- `onchain/raider/programs/raider/src/settle.rs`: deadline predicates and borrow-fee math.
- `onchain/raider/programs/raider/src/lib.rs`: open, force-close, tick, lever, flip, and settle integration.
- `redline3d/src/chain/config.ts`: active SOL currency compatibility exports.
- `redline3d/src/chain/chain-round.ts`: Highway constants, crank sizing, and Round helper.
- `redline3d/src/chain/game-session.ts`: live-round adoption, Highway crank rearming, and confirmed leverage callback.
- `redline3d/src/core/round.ts`: optional borrow-fee preview and no-expiry local engine behavior.
- `redline3d/src/core/money.ts`: compatibility wrappers backed by the active currency formatter.
- `redline3d/src/ui/hud.ts`: active currency label and open-position timer state.
- `redline3d/src/ui/wallet.ts`: active currency metadata instead of SOL literals.
- `redline3d/src/main.ts`: Highway entry, open, restore, automatic driving, slider, and remote cars.
- `redline3d/src/core/presence.ts`: lobby and Highway presence union.
- `server/src/presence/protocol.ts`: strict Highway advertisement schema.
- `server/src/presence/room.ts`: wallet-bound member state and asset-partitioned snapshots.
- `server/src/presence/socket.ts`: attach the authenticated user's bound wallet.
- Existing tests beside every modified module.

---

### Task 1: Currency-Ready SOL Boundary

**Files:**
- Create: `redline3d/src/core/stake-currency.ts`
- Create: `redline3d/src/core/stake-currency.test.ts`
- Modify: `redline3d/src/chain/config.ts`
- Modify: `redline3d/src/core/money.ts`
- Modify: `redline3d/src/main.ts`
- Modify: `redline3d/src/ui/hud.ts`
- Modify: `redline3d/src/ui/wallet.ts`
- Modify: `redline3d/src/ui/trade-history.ts`
- Test: `redline3d/src/chain/config.test.ts`
- Test: `redline3d/src/ui/wallet.test.ts`
- Test: `redline3d/src/ui/trade-history.test.ts`

**Interfaces:**
- Produces: `StakeCurrency`, `ACTIVE_STAKE_CURRENCY`, `unitsToBase`, `baseToUnits`, `formatStakeUnits`.
- Consumers: all later Highway client tasks and existing wallet/HUD money display.

- [ ] **Step 1: Write the failing currency tests**

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STAKE_CURRENCY,
  baseToUnits,
  formatStakeUnits,
  unitsToBase,
} from "./stake-currency";

describe("active stake currency", () => {
  it("defines SOL without coupling consumers to nine decimals", () => {
    expect(ACTIVE_STAKE_CURRENCY).toMatchObject({
      key: "SOL",
      symbol: "SOL",
      mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
      displayUnitDecimals: 2,
      fundingMode: "native-wrap",
    });
  });

  it("converts centi-SOL display units and base units exactly", () => {
    expect(unitsToBase(1)).toBe(10_000_000);
    expect(baseToUnits(25_000_000n)).toBe(2.5);
    expect(formatStakeUnits(2.5, 3)).toBe("0.025 SOL");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `cd redline3d && npm test -- src/core/stake-currency.test.ts`

Expected: FAIL because `./stake-currency` does not exist.

- [ ] **Step 3: Implement the currency boundary**

```ts
export type StakeCurrencyKey = "SOL";
export type StakeFundingMode = "native-wrap" | "spl-transfer";

export interface StakeCurrency {
  key: StakeCurrencyKey;
  symbol: string;
  mint: string;
  decimals: number;
  displayUnitDecimals: number;
  fundingMode: StakeFundingMode;
  initialBuyInBase: number;
}

export const ACTIVE_STAKE_CURRENCY: StakeCurrency = Object.freeze({
  key: "SOL",
  symbol: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
  displayUnitDecimals: 2,
  fundingMode: "native-wrap",
  initialBuyInBase: 100_000_000,
});

export const basePerDisplayUnit = (currency = ACTIVE_STAKE_CURRENCY): number =>
  10 ** (currency.decimals - currency.displayUnitDecimals);

export const unitsToBase = (units: number, currency = ACTIVE_STAKE_CURRENCY): number =>
  Math.round(units * basePerDisplayUnit(currency));

export const baseToUnits = (base: bigint, currency = ACTIVE_STAKE_CURRENCY): number =>
  Number(base) / basePerDisplayUnit(currency);

export function formatStakeUnits(
  units: number,
  fractionDigits = 3,
  currency = ACTIVE_STAKE_CURRENCY,
): string {
  return `${(units / 10 ** currency.displayUnitDecimals).toFixed(fractionDigits)} ${currency.symbol}`;
}
```

Change `CHAIN.STAKE_MINT` and `CHAIN.STAKE_DECIMALS` to compatibility aliases sourced from `ACTIVE_STAKE_CURRENCY`. Replace `BASE_PER_UNIT`, `BUY_IN_BASE`, `unitsToBase`, and `baseToUnits` in `main.ts` with imports. Make `sol` and `sol3` delegate to `formatStakeUnits`. Pass the active currency to HUD, wallet, and trade-history rendering so visible labels use `currency.symbol`.

- [ ] **Step 4: Run currency, config, wallet, and build checks**

Run: `cd redline3d && npm test -- src/core/stake-currency.test.ts src/chain/config.test.ts src/ui/wallet.test.ts src/ui/trade-history.test.ts && npm run build`

Expected: all selected tests PASS and TypeScript/Vite build succeeds.

- [ ] **Step 5: Commit the currency boundary**

```bash
git add redline3d/src/core/stake-currency.ts redline3d/src/core/stake-currency.test.ts redline3d/src/chain/config.ts redline3d/src/chain/config.test.ts redline3d/src/core/money.ts redline3d/src/main.ts redline3d/src/ui/hud.ts redline3d/src/ui/wallet.ts redline3d/src/ui/wallet.test.ts redline3d/src/ui/trade-history.ts redline3d/src/ui/trade-history.test.ts
git commit -m "refactor: make SOL stake currency configurable"
```

---

### Task 2: Open-Ended Round Marker Without Account Migration

**Files:**
- Modify: `onchain/raider/programs/raider/src/state.rs`
- Modify: `onchain/raider/programs/raider/src/settle.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs`

**Interfaces:**
- Produces: `HIGHWAY_DURATION_SENTINEL`, `is_open_ended`, `deadline_elapsed`, `highway_round_marker`.
- Consumers: borrow-fee math, force-close, tick, settle labeling, and client reconnect.

- [ ] **Step 1: Add failing Rust tests for deadline semantics**

```rust
#[test]
fn negative_deadline_is_open_ended_and_never_elapsed() {
    assert!(is_open_ended(-123));
    assert!(!is_open_ended(0));
    assert!(!deadline_elapsed(10_000, -123));
    assert!(!deadline_elapsed(10_000, 0));
    assert!(deadline_elapsed(101, 100));
}

#[test]
fn highway_marker_is_negative_and_slot_specific() {
    assert_eq!(highway_round_marker(42).unwrap(), -42);
    assert_ne!(highway_round_marker(42).unwrap(), highway_round_marker(43).unwrap());
}
```

Add one `tick_action` assertion proving a negative deadline holds at a benign mark while a positive elapsed deadline settles.

- [ ] **Step 2: Run the Rust tests and confirm missing helpers**

Run: `cd onchain/raider && cargo test -p raider negative_deadline`

Expected: FAIL because the helpers are undefined.

- [ ] **Step 3: Implement marker and deadline helpers**

```rust
pub const HIGHWAY_DURATION_SENTINEL: i64 = -1;

pub fn highway_round_marker(slot: u64) -> Result<i64> {
    let slot = i64::try_from(slot).map_err(|_| error!(RaiderError::MathOverflow))?;
    Ok(-slot.max(1))
}
```

```rust
pub fn is_open_ended(deadline_ts: i64) -> bool {
    deadline_ts < 0
}

pub fn deadline_elapsed(now: i64, deadline_ts: i64) -> bool {
    deadline_ts > 0 && now >= deadline_ts
}
```

In `open`, fetch `Clock` once and set:

```rust
round.deadline_ts = if dur == state::HIGHWAY_DURATION_SENTINEL {
    state::highway_round_marker(clock.slot)?
} else {
    let secs = if dur <= 0 { MAX_ROUND_SECS } else { dur.clamp(MIN_ROUND_SECS, HARD_MAX_ROUND_SECS) };
    now.checked_add(secs).ok_or(RaiderError::MathOverflow)?
};
```

Replace every raw `now >= deadline_ts` check in `fires`, `tick_action`, `force_close`, and time-outcome relabeling with `deadline_elapsed`. `force_close` must reject a negative marker with `NotYetExpired`.

- [ ] **Step 4: Prove Track parity and Highway no-expiry behavior**

Run: `cd onchain/raider && cargo test -p raider`

Expected: 40 or more tests PASS, including all pre-existing 38 tests.

- [ ] **Step 5: Commit open-ended deadline support**

```bash
git add onchain/raider/programs/raider/src/state.rs onchain/raider/programs/raider/src/settle.rs onchain/raider/programs/raider/src/lib.rs
git commit -m "feat: add open-ended Highway rounds"
```

---

### Task 3: Lazy Borrow-Fee Settlement

**Files:**
- Modify: `onchain/raider/programs/raider/src/settle.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs`

**Interfaces:**
- Consumes: `is_open_ended(deadline_ts)` from Task 2.
- Produces: `borrow_fee_fp` and `accrue_borrow_fee_fp`.

- [ ] **Step 1: Add exact fee-vector tests**

```rust
#[test]
fn highway_borrow_fee_is_one_bp_of_notional_per_day() {
    assert_eq!(borrow_fee_fp(10, 86_400), 1_000);
    assert_eq!(borrow_fee_fp(250, 86_400), 25_000);
    assert_eq!(borrow_fee_fp(250, 43_200), 12_500);
}

#[test]
fn fee_accrual_only_changes_open_ended_rounds() {
    assert_eq!(accrue_borrow_fee_fp(0, 250, 100, 86_500, -42), -25_000);
    assert_eq!(accrue_borrow_fee_fp(0, 250, 100, 86_500, 90_000), 0);
    assert_eq!(accrue_borrow_fee_fp(7, 250, 200, 100, -42), 7);
}
```

Add a rebank test proving two 12-hour 250x segments charge exactly the same 25,000 fixed-point units as one 24-hour segment.

- [ ] **Step 2: Run the fee tests and confirm failure**

Run: `cd onchain/raider && cargo test -p raider borrow_fee`

Expected: FAIL because the fee helpers do not exist.

- [ ] **Step 3: Implement checked, house-favorable fee math**

```rust
pub const HIGHWAY_BORROW_BPS_PER_DAY: i128 = 1;
const BPS_DENOM: i128 = 10_000;
const DAY_SECS: i128 = 86_400;

pub fn borrow_fee_fp(lev: u32, elapsed_secs: i64) -> i128 {
    if elapsed_secs <= 0 { return 0; }
    let num = (lev as i128) * SCALE * HIGHWAY_BORROW_BPS_PER_DAY * (elapsed_secs as i128);
    let den = BPS_DENOM * DAY_SECS;
    (num + den - 1) / den
}

pub fn accrue_borrow_fee_fp(
    banked_fp: i128,
    lev: u32,
    entry_ts: i64,
    now: i64,
    deadline_ts: i64,
) -> i128 {
    if !is_open_ended(deadline_ts) { return banked_fp; }
    banked_fp.saturating_sub(borrow_fee_fp(lev, now.saturating_sub(entry_ts)))
}
```

Before every `fires`, `tick_action`, `settle`, flip rebank, and lever rebank call, calculate fee-adjusted banked PnL. After a successful flip or lever reanchor, store `round.entry_ts = snap.publish_time` so a segment fee is never charged twice. Track rounds must flow through the same helper and remain unchanged because their deadline is positive.

- [ ] **Step 4: Run all program tests**

Run: `cd onchain/raider && cargo test -p raider`

Expected: all tests PASS with existing Track vectors unchanged and new Highway fee vectors green.

- [ ] **Step 5: Commit fee settlement**

```bash
git add onchain/raider/programs/raider/src/settle.rs onchain/raider/programs/raider/src/lib.rs
git commit -m "feat: accrue Highway borrow fees"
```

---

### Task 4: Highway Chain Session and Reconnect API

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts`
- Modify: `redline3d/src/chain/chain-round.test.ts`
- Modify: `redline3d/src/chain/game-session.ts`
- Modify: `redline3d/src/chain/game-session.test.ts`

**Interfaces:**
- Produces: `HIGHWAY_DURATION_SENTINEL = -1`, `HIGHWAY_CRANK_ITERATIONS = 86_400`, `isHighwayRound`, `GameSession.liveRound()`.
- Consumers: main restore flow and remote verification.

- [ ] **Step 1: Write failing client orchestration tests**

```ts
it("arms 24 hours of one-second ticks for an open-ended Highway round", async () => {
  const chain = fakeChain();
  const session = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
  await session.init();
  await session.open("SOL", 1, 250, 1_000_000, -1, 200_000);
  expect(chain.scheduleCrank).toHaveBeenCalledWith(expect.objectContaining({ iterations: 86_400 }));
});

it("exposes an adopted open Highway round after reconnect", async () => {
  const open = snap(-123, { status: 1, lev: 250, dir: -1 });
  const chain = fakeChain({ delegationState: vi.fn(async () => "reuse"), readRound: vi.fn(async () => open) });
  const session = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
  await session.init();
  expect(session.liveRound()).toEqual(open);
});
```

- [ ] **Step 2: Run focused client tests and confirm interface failures**

Run: `cd redline3d && npm test -- src/chain/chain-round.test.ts src/chain/game-session.test.ts`

Expected: FAIL because `liveRound` and Highway crank constants do not exist.

- [ ] **Step 3: Implement the session boundary**

```ts
export const HIGHWAY_DURATION_SENTINEL = -1;
export const HIGHWAY_CRANK_ITERATIONS = 24 * 60 * 60;
export const isHighwayRound = (round: Pick<RoundSnap, "status" | "deadlineTs">): boolean =>
  round.status === 1 && round.deadlineTs < 0;
```

Add `liveRound(): RoundSnap | null` to `GameSession`, store the adopted open snapshot in `adoptAndRead`, clear it on settlement/logout, and refresh it after open/lever/poll. Size crank iterations with:

```ts
const iterations = durationSecs === HIGHWAY_DURATION_SENTINEL
  ? HIGHWAY_CRANK_ITERATIONS
  : durationSecs + 10;
```

Store the active Round identity and crank coverage deadline in client storage. On reconnect, schedule a new window only when that Round has no unexpired recorded coverage. Do not rearm after lever actions. Keep the existing latest-wins lever synchronization.

- [ ] **Step 4: Run session tests and build**

Run: `cd redline3d && npm test -- src/chain/chain-round.test.ts src/chain/game-session.test.ts && npm run build`

Expected: tests PASS and the client builds.

- [ ] **Step 5: Commit session support**

```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/chain-round.test.ts redline3d/src/chain/game-session.ts redline3d/src/chain/game-session.test.ts
git commit -m "feat: add Highway chain session lifecycle"
```

---

### Task 5: Fee-Aware Local Preview and Automatic Highway Motion

**Files:**
- Create: `redline3d/src/core/highway-auto.ts`
- Create: `redline3d/src/core/highway-auto.test.ts`
- Modify: `redline3d/src/core/round.ts`
- Modify: `redline3d/src/core/round.test.ts`

**Interfaces:**
- Produces: `HIGHWAY_MIN_LEV`, `HIGHWAY_MAX_LEV`, `snapHighwayLeverage`, `speedForLeverage`, `seedHighwayMotion`, `stepHighwayMotion`.
- Consumers: slider and main frame loop.

- [ ] **Step 1: Write failing automatic-motion tests**

```ts
import { describe, expect, it } from "vitest";
import {
  seedHighwayMotion,
  snapHighwayLeverage,
  speedForLeverage,
  stepHighwayMotion,
} from "./highway-auto";

describe("automatic Highway motion", () => {
  it("snaps and clamps the 10x to 250x slider", () => {
    expect(snapHighwayLeverage(4)).toBe(10);
    expect(snapHighwayLeverage(146)).toBe(150);
    expect(snapHighwayLeverage(999)).toBe(250);
  });

  it("makes 250x faster than 10x", () => {
    expect(speedForLeverage(250)).toBeGreaterThan(speedForLeverage(10));
  });

  it("moves long and short in opposite arc-length directions", () => {
    const long = stepHighwayMotion(seedHighwayMotion("wallet", 1), 100, 1);
    const short = stepHighwayMotion(seedHighwayMotion("wallet", -1), 100, 1);
    expect(long.s).toBeGreaterThan(seedHighwayMotion("wallet", 1).s);
    expect(short.s).toBeLessThan(seedHighwayMotion("wallet", -1).s);
  });
});
```

Add a RoundEngine test launching with `maxSec: Number.POSITIVE_INFINITY` and `borrowBpsPerDay: 1`, then assert a flat 250x position has equity `0.975` after 24 hours and does not time-settle.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cd redline3d && npm test -- src/core/highway-auto.test.ts src/core/round.test.ts`

Expected: FAIL because the motion module and fee-aware launch option are missing.

- [ ] **Step 3: Implement pure automatic motion**

```ts
import { LEN, TRACK, sample } from "./track";

export const HIGHWAY_MIN_LEV = 10;
export const HIGHWAY_MAX_LEV = 250;
export const HIGHWAY_LEV_STEP = 10;
const MIN_SPEED = 38;
const MAX_SPEED = 128;

export interface HighwayMotion { s: number; dir: 1 | -1; lane: number }

export const snapHighwayLeverage = (value: number): number =>
  Math.max(HIGHWAY_MIN_LEV, Math.min(HIGHWAY_MAX_LEV, Math.round(value / HIGHWAY_LEV_STEP) * HIGHWAY_LEV_STEP));

export const speedForLeverage = (lev: number): number => {
  const t = (snapHighwayLeverage(lev) - HIGHWAY_MIN_LEV) / (HIGHWAY_MAX_LEV - HIGHWAY_MIN_LEV);
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.sqrt(t);
};

export function seedHighwayMotion(seed: string, dir: 1 | -1): HighwayMotion {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return { s: ((hash >>> 0) / 0xffffffff) * LEN, dir, lane: (hash >>> 0) % TRACK.LANES };
}

export function stepHighwayMotion(state: HighwayMotion, lev: number, dt: number): HighwayMotion {
  return { ...state, s: state.s + state.dir * speedForLeverage(lev) * Math.max(0, dt) };
}

export function highwayPose(state: HighwayMotion) {
  const c = sample(state.s);
  const lat = state.dir * (TRACK.MEDIAN_HALF + TRACK.LANE_W * (state.lane + 0.5));
  const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
  return {
    x: c.x + rx * lat,
    z: c.z + rz * lat,
    heading: state.dir === 1 ? c.heading : c.heading + Math.PI,
  };
}
```

Extend `LaunchParams` with `borrowBpsPerDay?: number`. Track a segment start time in `RoundEngine`, subtract `lev * bps / 10_000 * elapsed / 86_400_000` from live equity, bank it once during `setLeverage`, and skip the time terminal when `maxSec` is infinite. The default fee remains zero, preserving Track.

- [ ] **Step 4: Run motion and engine tests**

Run: `cd redline3d && npm test -- src/core/highway-auto.test.ts src/core/round.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit automatic motion and preview parity**

```bash
git add redline3d/src/core/highway-auto.ts redline3d/src/core/highway-auto.test.ts redline3d/src/core/round.ts redline3d/src/core/round.test.ts
git commit -m "feat: add automatic Highway motion"
```

---

### Task 6: Highway Leverage Slider

**Files:**
- Create: `redline3d/src/ui/highway-controls.ts`
- Create: `redline3d/src/ui/highway-controls.test.ts`

**Interfaces:**
- Consumes: leverage constants and snap function from Task 5.
- Produces: `HighwayControls` with `show`, `hide`, `value`, `setConfirmed`, `setSyncing`, and `onCommit`.

- [ ] **Step 1: Write failing DOM tests**

```ts
it("previews during input and commits once on change", () => {
  const commits: number[] = [];
  const controls = createHighwayControls(document.body, { onCommit: (lev) => commits.push(lev) });
  controls.show();
  const slider = document.querySelector<HTMLInputElement>("[data-highway-leverage]")!;
  slider.value = "146";
  slider.dispatchEvent(new Event("input"));
  expect(document.body.textContent).toContain("150x");
  expect(commits).toEqual([]);
  slider.dispatchEvent(new Event("change"));
  expect(commits).toEqual([150]);
});

it("shows requested and confirmed values while syncing", () => {
  const controls = createHighwayControls(document.body, { onCommit: vi.fn() });
  controls.setConfirmed(100);
  controls.setSyncing(250);
  expect(document.body.textContent).toContain("250x");
  expect(document.body.textContent).toContain("SYNCING");
});
```

- [ ] **Step 2: Run the slider tests and confirm missing module**

Run: `cd redline3d && npm test -- src/ui/highway-controls.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the slider component**

Create one fixed mobile-safe control containing an accessible `<input type="range" min="10" max="250" step="10">`, a large requested leverage label, a confirmed leverage label, and `SYNCING` state. `input` updates only preview. `change`, pointer release, or touch release calls `onCommit` once with the snapped value. `setConfirmed` clears syncing only when the confirmed value equals the outstanding request.

The public interface is:

```ts
export interface HighwayControls {
  show(): void;
  hide(): void;
  value(): number;
  setConfirmed(lev: number): void;
  setSyncing(lev: number | null): void;
  setDisabled(disabled: boolean): void;
  setSentiment(longCount: number, shortCount: number, averageLeverage: number): void;
}
```

`setSentiment` renders `LONG N`, `SHORT N`, and `AVG Mx` in the same panel. It starts at zero and is updated from verified presence only.

- [ ] **Step 4: Run component tests and build**

Run: `cd redline3d && npm test -- src/ui/highway-controls.test.ts && npm run build`

Expected: tests PASS and build succeeds.

- [ ] **Step 5: Commit the slider**

```bash
git add redline3d/src/ui/highway-controls.ts redline3d/src/ui/highway-controls.test.ts
git commit -m "feat: add Highway leverage slider"
```

---

### Task 7: Wire Highway Open, Automatic Driving, and Restore

**Files:**
- Modify: `redline3d/src/main.ts`
- Modify: `redline3d/src/ui/hud.ts`
- Modify: `redline3d/src/ui/hud.test.ts`
- Modify: `redline3d/src/core/mode-guard.test.ts`

**Interfaces:**
- Consumes: active currency, `GameSession.liveRound`, automatic motion, slider, and existing oval renderer.
- Produces: the playable solo MagicBlock-native Highway.

- [ ] **Step 1: Add failing HUD and mode tests**

```ts
it("shows OPEN instead of a countdown for an open-ended position", () => {
  const hud = createHud(document.body);
  hud.setOpenPosition(true);
  expect(document.querySelector("#timer")?.textContent).toBe("OPEN");
});

it("allows the Highway gate while no round is live", () => {
  expect(modeSwitchBlocked({ opening: false, phase: "idle", roundActive: false })).toBe(false);
});
```

- [ ] **Step 2: Run the tests and confirm the missing HUD interface**

Run: `cd redline3d && npm test -- src/ui/hud.test.ts src/core/mode-guard.test.ts`

Expected: FAIL because `setOpenPosition` does not exist.

- [ ] **Step 3: Replace manual Highway wiring**

In `triggerBuilding`, call `enterHighway()` instead of the coming-soon toast. Create the slider beside the other UI components. On Highway GO:

```ts
const lev = highwayControls.value();
const duration = HIGHWAY_DURATION_SENTINEL;
opened = await session.open(asset, dir, lev, unitsToBase(playAmount), duration, liqFp, graceSecs, slFp, tpFp, refundFp);
engine.launch({
  dir,
  lev,
  stake: playAmount,
  entryRaw: opened.entryHuman,
  startMs: Date.now(),
  maxSec: Number.POSITIVE_INFINITY,
  borrowBpsPerDay: 1,
});
highwayMotion = seedHighwayMotion(roundKey({ deadlineTs: opened.deadlineTs }, session.address()), dir);
```

In the Highway frame branch, remove throttle, steering, `driveStep`, `contain`, and speed-to-gear calls. Advance `highwayMotion`, derive the pose, update the car, and use confirmed leverage as the speed input. Slider commit must call `engine.setLeverage(requested, roundPrice, nowMs)` and `session.noteLeverage(requested)` once. The UI remains syncing until poll or lever confirmation reports the canonical leverage.

Set `hud.setOpenPosition(true)` while a Highway Round is live and never call the local time-expiry close path. Keep cash-out, cap, liquidation, stop-loss, and take-profit behavior.

After a successful wallet reconnect, inspect `session.liveRound()`. If it is open with a negative deadline, set asset, direction, leverage, entry state, `roundActive`, engine state, deterministic Highway motion, and call `enterHighway()` automatically. If it is settled, use the existing stored-result path.

- [ ] **Step 4: Run all frontend tests and build**

Run: `cd redline3d && npm test && npm run build`

Expected: 848 or more tests PASS, devnet-only tests remain skipped, and build succeeds.

- [ ] **Step 5: Commit the playable solo Highway**

```bash
git add redline3d/src/main.ts redline3d/src/ui/hud.ts redline3d/src/ui/hud.test.ts redline3d/src/core/mode-guard.test.ts
git commit -m "feat: launch MagicBlock-native Highway"
```

---

### Task 8: Wallet-Bound Highway Presence and Round Verification

**Files:**
- Modify: `server/src/presence/protocol.ts`
- Modify: `server/src/presence/protocol.test.ts`
- Modify: `server/src/presence/room.ts`
- Modify: `server/src/presence/room.test.ts`
- Modify: `server/src/presence/socket.ts`
- Modify: `server/src/presence/socket.test.ts`
- Modify: `redline3d/src/core/presence.ts`
- Modify: `redline3d/src/core/presence.test.ts`
- Create: `redline3d/src/chain/highway-verifier.ts`
- Create: `redline3d/src/chain/highway-verifier.test.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Produces: strict `HighwayPresence`, asset-filtered snapshots, and `verifyHighwayPresence`.
- Consumers: oval remote car rendering and sentiment display.

- [ ] **Step 1: Add failing server protocol and verification tests**

```ts
it("accepts a strict Highway state advertisement", () => {
  expect(parseClientMessage(JSON.stringify({
    type: "highway",
    asset: "SOL",
    roundPda: "Round1111111111111111111111111111111111",
    dir: 1,
    lev: 250,
    laneSeed: 2,
    carId: "Orion",
  }))).toMatchObject({ type: "highway", asset: "SOL", dir: 1, lev: 250 });
});
```

```ts
it("accepts only a matching live open-ended Round", async () => {
  const advertised = { wallet: WALLET, roundPda: ROUND, asset: "SOL" as const, dir: 1 as const, lev: 250, laneSeed: 2, carId: "Orion" };
  const verified = await verifyHighwayPresence(advertised, async () => ({
    owner: WALLET,
    feed: CHAIN.FEEDS.SOL.toBase58(),
    status: 1,
    deadlineTs: -123,
    dir: 1,
    lev: 250,
  }));
  expect(verified).toEqual(advertised);
});
```

Add rejection vectors for an unbound wallet, wrong PDA, timed Round, settled Round, wrong asset feed, wrong direction, and wrong leverage.

- [ ] **Step 2: Run presence tests and confirm schema failures**

Run: `cd server && npm test -- src/presence/protocol.test.ts src/presence/room.test.ts src/presence/socket.test.ts`

Run: `cd redline3d && npm test -- src/core/presence.test.ts src/chain/highway-verifier.test.ts`

Expected: FAIL because Highway presence types and verifier are missing.

- [ ] **Step 3: Implement strict wallet-bound presence**

Add this client message to the Zod union:

```ts
z.object({
  type: z.literal("highway"),
  asset: z.enum(["BTC", "ETH", "SOL"]),
  roundPda: z.string().min(32).max(44),
  dir: z.union([z.literal(1), z.literal(-1)]),
  lev: z.number().int().min(10).max(250).multipleOf(10),
  laneSeed: z.number().int().min(0).max(2),
  carId: carIdSchema,
}).strict()
```

When authenticating the socket, require `user.walletPublicKey` before accepting a Highway advertisement. The server adds the wallet from the authenticated user record; it never trusts a client-supplied wallet. Raise the room render cap from 8 to 32 and keep pose/emote rate limits unchanged.

Implement `verifyHighwayPresence` as a pure validator with an injected account reader. The production reader derives `[b"round", wallet]`, requires it to equal `roundPda`, decodes the ER Round account, and checks owner, feed, status, negative deadline, direction, and leverage.

Partition remote snapshots by `asset`. In `main.ts`, send Highway advertisements only for a signed-in, non-practice, open Round. Verify remote entries before passing deterministic poses to `oval.setRemoteCars`. Compute long count, short count, and average confirmed leverage from the verified set and call `highwayControls.setSentiment`. If verification or presence fails, remove only that remote car and keep the local financial session running.

- [ ] **Step 4: Run server and frontend suites**

Run: `cd server && npm test && npm run build`

Run: `cd redline3d && npm test && npm run build`

Expected: all server and frontend tests PASS.

- [ ] **Step 5: Commit verified multiplayer**

```bash
git add server/src/presence redline3d/src/core/presence.ts redline3d/src/core/presence.test.ts redline3d/src/chain/highway-verifier.ts redline3d/src/chain/highway-verifier.test.ts redline3d/src/main.ts
git commit -m "feat: show verified Highway positions"
```

---

### Task 9: Full Verification and Devnet Hackathon Gate

**Files:**
- Modify only files required to fix verification failures found in this task.
- Record no secrets or funded keypairs in the repository.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a green branch and a reproducible devnet demo checklist.

- [ ] **Step 1: Run all local automated checks**

```bash
(cd onchain/raider && cargo test -p raider)
(cd packages/engine && npm test && npm run build)
(cd server && npm test && npm run build)
(cd redline3d && npm test && npm run build)
```

Expected: every command exits 0. Existing Anchor `unexpected cfg` warnings may remain, but no test or build failures are allowed.

- [ ] **Step 2: Run the local ER integration flow**

Use the repository's existing local validator and MagicBlock ER setup. Verify in order:

```text
1. Open a timed Track Round and confirm its positive deadline still settles by time.
2. Open a Highway Round at 10x and confirm its deadline marker is negative.
3. Move the slider to 250x and confirm one coalesced lever instruction lands.
4. Close the browser, reopen the same wallet, and confirm Highway restores.
5. Leave the browser closed and confirm a scheduled tick can liquidate the Round.
6. Cash out a surviving Round and confirm player plus house value is conserved.
```

- [ ] **Step 3: Run the devnet smoke test**

Run: `cd redline3d && RAIDER_DEVNET=1 npm test -- --config vitest.config.devnet.ts`

Expected: configured devnet tests PASS. If the deployed devnet program does not yet contain the branch changes, stop and report that deployment is required instead of claiming success.

- [ ] **Step 4: Verify the mobile demo manually**

```text
1. Enter Highway from the lobby gate on a narrow mobile viewport.
2. Open long and short positions from two wallet-bound clients on the same asset.
3. Confirm opposite carriageways and leverage-dependent speed.
4. Confirm the 10x to 250x slider previews locally and syncs once per release.
5. Confirm each client sees the other only after Round verification.
6. Confirm presence loss degrades to solo mode without affecting cash-out.
7. Return to Track and confirm its driving and timer are unchanged.
```

- [ ] **Step 5: Commit verification-only fixes, if any**

```bash
git add onchain/raider/programs/raider/src/state.rs onchain/raider/programs/raider/src/settle.rs onchain/raider/programs/raider/src/lib.rs redline3d/src server/src/presence
git commit -m "test: harden MagicBlock Highway flow"
```

Skip this commit when verification required no changes.
