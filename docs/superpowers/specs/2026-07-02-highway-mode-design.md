# Highway Mode — Free-Drive Perps on an Oval Track

**Date:** 2026-07-02
**Branch:** `onchain-er-rebuild`
**Status:** Design — approved, pending spec review

## Summary

A third game mode for Perps Rider, alongside the endless-road **racer** and the
**lobby** economy hub. On a real, static **oval highway** — a *divided* road with a
median, two lanes per carriageway, and traffic running opposite ways on each side —
the player picks **LONG or SHORT in the GO panel** (the racer's existing direction
control), spawns into the matching carriageway, and then *speed is the leverage*: a
gear ladder from the program's 10× floor up to **100×**. Direction is **locked for
the round** — the only exits are CASH OUT, liquidation, or the timer. Other
players appear as non-colliding **ghost cars** on the same track. The on-chain
program is **untouched** — money, settlement, the Lazer feed, and the crank stay
exactly as they are today; only the *input layer* mapping driving → position is new.

## Goals / Non-Goals

**Goals**
- A drivable oval built from a *real static world* (like the lobby), not the
  racer's scrolling-shader illusion — so ghost cars share a coherent coordinate space.
- Long/short is a deliberate UI choice at entry: the GO panel's existing direction
  toggle picks the side; the game spawns you into the matching carriageway.
- Speed controls the leverage: a gear ladder from the program's 10× floor up to 100×.
- A divided highway: two lanes per carriageway, median between, opposite directions
  per side — longs drive one way, shorts drive the other, so market sentiment reads
  as two-way traffic.
- Ghost presence: see other players' cars, no collisions, no gameplay interaction.
- Reuse the existing round machinery wholesale: `game-session`, `RoundEngine`,
  `lever-sync`, `controls` (GO / CASH OUT / LONG-SHORT toggle).

**Non-Goals**
- No changes to the on-chain `raider` program (no redeploy, no migration).
- No collisions, no shared authoritative state, no PvP outcomes — ghosts are cosmetic.
- No pit-lane cash-out mechanic. Open = GO button, close = CASH OUT button.
- **No mid-round flip** — no U-turn mechanic, no FLIP button. Direction is locked at
  open; driving the wrong way is harmless fun with zero trade effect.
- Lane choice and driving direction are positional/cosmetic — only speed touches the
  position once the round is open.
- Not the racer's 2000× ceiling: this mode is capped at 100×.

## Architecture

A new `mode: "highway"` value threaded through `main.ts` beside `"race" | "lobby"`.
Entered from the lobby via a new **HIGHWAY** gate (the existing **Track** gate keeps
launching the classic racer). The world, physics, and camera reuse proven lobby
pieces; only the track geometry and the trade-mapping are new.

```
lobby ──(HIGHWAY gate)──▶ highway ──(exit / CASH OUT settle)──▶ lobby
                              │
              GO panel: stake + LONG/SHORT ──▶ session.open(asset, dir, …)
                              │                     (dir locked for the round)
                       drive (freedrive.step)
                              │
                 ┌────────────┴─────────────┐
                 ▼                            ▼
        track.contain(x,z)           highway-gears(speed)
        (stay on the ribbon)         → gear → leverage(10..100)
                                                │
                                                ▼
                                     session.noteLeverage(lev)   [lever-sync coalesces]
                                                │
                                                └──▶ on-chain lever()
```

### Components (each isolated + independently testable)

1. **`src/core/track.ts`** — *pure geometry, no THREE / no DOM.*
   Defines the oval **centerline** (two straights joined by two 180° arcs) with an
   arc-length parameter `s ∈ [0, L)`. Exports:
   - `progress(x, z, prevS): { s, lateralOffset, tangentHeading }` — projects a world
     point to the nearest point on the centerline. `lateralOffset` is signed distance
     from centerline (which carriageway/lane); `tangentHeading` is the track's forward
     yaw there. Used for spawning, ghost placement, and the minimap.
   - `contain(x, z): { x, z, hitWall }` — clamps a point to the drivable ribbon
     (inner median edge ↔ outer barrier), returning the corrected position. Replaces
     `freedrive`'s rectangular `Bounds` clamp for this mode.
   - `spawn(dir): DriveState` — a start pose in the carriageway matching the chosen
     side, facing that side's traffic flow.

2. **`src/core/highway-gears.ts`** — *pure mapping, no THREE / no DOM.*
   - `gearOf(speedFrac): number` — maps |speed|/MAX_FWD into `N` discrete gears with
     **hysteresis** (upshift/downshift thresholds differ) so leverage doesn't flicker
     at a boundary.
   - `levOf(gear): number` — gear → leverage on a ladder spanning `[MIN_LEV=10, 100]`
     (10 is the program's floor; a stopped car is a live 10× position, top gear = 100×).

3. **`src/render/oval.ts`** — *the THREE world* (mirrors `render/lobby.ts` structure).
   Builds the ribbon (two straights + two arcs), painted lane lines, a raised median,
   outer barriers, neon lighting, plus a `remoteGroup` + `setRemoteCars(states)` ghost
   renderer identical in shape to `lobby.ts`. `show()/hide()/update(dt)/dispose()`.

4. **`src/main.ts` wiring** — `enterHighway()/exitHighway()` (guarded like `enterLobby`:
   refuse while a round is `live`), a `mode === "highway"` branch in `frame()` that:
   drives with `freedrive.step` but swaps the rectangular clamp for `track.contain`;
   feeds speed → gears → `session.noteLeverage`; renders via `oval` + `lobbyCam`.
   GO / CASH OUT / the LONG-SHORT toggle are the existing `controls` handlers — the
   highway-specific changes are clamping the opened leverage to `[10, 100]`, spawning
   at `track.spawn(controls.dir())` on open, and never calling `doFlip` in this mode.

5. **`src/net/presence.ts` + `server/presence.mjs`** *(Phase 2)* — a ~100-line Node
   WebSocket fan-out (deployed to Railway) and a thin browser client. Broadcasts
   `{ id, x, z, heading, dir }` a few times a second; feeds `oval.setRemoteCars`.
   No auth — positions are cosmetic and all money is on-chain. Disconnect just freezes
   or drops ghosts; it can never touch a round.

## Data Flow (one highway frame)

1. Read input (touch drag / WASD) → `freedrive.step(drive, {throttle, steer}, dt)`.
2. `track.contain` keeps the car on the ribbon (kills speed on wall contact).
3. `gearOf(|speed|/MAX_FWD)` → `levOf` → `lev`; set `game.lev` (instant local feel via
   `RoundEngine`) and `session.noteLeverage(lev)` (lever-sync coalesces the on-chain send).
4. Render car at `(x, z, heading)`, `oval.update(dt)`, `oval.setRemoteCars(...)`, `lobbyCam.update`.

Direction is set once, at open: GO reads the panel's LONG/SHORT toggle, passes it to
`session.open(asset, dir, …)`, and respawns the car via `track.spawn(dir)` so the player
starts in their side's carriageway. Nothing the wheels do afterward can change `dir`.

## On-Chain / Money (unchanged)

GO runs the exact existing path: `ensureSession` (buy-in + slice till + delegate) →
`session.open(asset, dir, lev, stake, maxSec, liqFp, …)` → crank armed. The round
settles the same four ways (cashout / cap / liq / time) via the same crank and
`finalizeSettled`. CASH OUT = `closeRound("cashout")`. The **only** money-facing
difference from the racer: leverage is clamped to `[10, 100]` at open and while driving.
All existing error handling carries over (HouseUndercapitalized auto-reset,
delegate-busy friendly message, unfunded-wallet fail-fast).

## Error Handling & Edge Cases

- **Enter guard:** cannot enter/leave highway while a round is `live` (same rule as lobby).
- **Direction is immutable in-round:** the LONG/SHORT toggle locks at GO (the racer's
  `hud.onAsset`-style live-lock pattern); wrong-way driving never touches the position.
- **Gear flicker:** hysteresis in `gearOf` prevents rapid lever churn at a threshold;
  `lever-sync` already coalesces to latest-wins with at most one send in flight.
- **Presence loss (Phase 2):** WS drop → ghosts freeze/vanish; round untouched.
- **Stationary car:** valid live 10× position; the crank still governs time/liq.

## Testing

- **Unit (pure, TDD):** `track.ts` — projection accuracy, lateral sign per carriageway,
  `s` wrap at the seam, `contain` clamp on straights vs arcs, `spawn(dir)` pose per side.
  `highway-gears.ts` — monotonic gear ladder, clamp to `[10,100]`, hysteresis (no
  flicker across a boundary).
- **Browser (devnet, mandatory before "done"):** load the real game, enter HIGHWAY from
  the lobby, pick a side + GO → spawn in the right carriageway, drive the loop and watch
  `×`/leverage track speed (on-chain `lever` fills), confirm the toggle is locked while
  live, CASH OUT settles, End undelegates clean.
  Phase 2: two browser clients see each other's ghost.

## Phasing

- **Phase 1 — Solo highway (ship first):** `track.ts`, `highway-gears.ts`, `render/oval.ts`,
  the lobby HIGHWAY gate, the `main.ts` mode + trade-mapping, 100× clamp. Browser-verified on devnet.
- **Phase 2 — Ghosts:** `server/presence.mjs` relay (Railway) + `net/presence.ts` client +
  `oval.setRemoteCars` broadcast loop. Browser-verified with two clients.

## Revision v2 — 2026-07-02 (user drive feedback, mid-build)

After driving Phase 1 on devnet the user directed five changes (supersedes the numbers above where they conflict):
1. **3× track scale**: R 60→180, STRAIGHT 200→600 (LEN ≈ 2331).
2. **3 lanes per carriageway, 3× road width**: LANE_W 6→12, LANES 3, MEDIAN_HALF 4, EDGE = 4 + 3×12 = 40.
3. **Speed**: top gear (100×) must *feel* like the racer's 1000× — a `HIGHWAY_DRIVE` tuning preset (MAX_FWD ≈ 100 u/s vs the lot's 28) fed to a parametrized `freedrive.step(…, tune)`; lobby keeps `DRIVE` unchanged.
4. **Elevation**: smooth periodic `elevationAt(s)` (two gentle hills/lap, ≤~11u); purely visual — physics stays 2D; car y + pitch follow the road; renderer ribbons/props follow.
5. **Soft walls**: contact must not zero speed — position still clamps (slide along the wall), speed decays by an exponential scrape (`WALL_SCRAPE`) while touching.
6. **Backdrop**: synthwave dressing around the oval (sky gradient dome, striped sun, mountain ring, stars) so the horizon isn't black.

## Revision v3 — 2026-07-02 (racer real-car feel)

User: "the main track feels really weird to drive.. i want this to feel like real car game."
The racer's lateral movement is a per-frame position spring (`carX += (carXTarget − carX) * 0.18`,
not dt-scaled) with yaw faked from the remaining error — no momentum, no grip, frame-rate-dependent.

Fix, without changing the input UX or the trading mechanics:
1. **New pure module `src/core/lane-drive.ts`**: 1-D lateral car dynamics for the scrolling
   road. State `{ x, vx, yaw }`. Each frame a PD controller turns the existing `carXTarget`
   into a bounded steering acceleration (`ax = clamp(K_P·(target−x) − K_D·vx, ±A_MAX·auth)`),
   `vx` integrates with grip decay, `x` integrates and clamps to the road (±10, `vx` zeroed
   into the edge only), `yaw` follows **actual lateral velocity** (not error) with easing.
   Authority `auth` scales with road speed (a slow car steers lazily, a fast one darts) —
   tuned near-critically damped with a whisper of underdamp for juice. dt-invariant
   (60 vs 120 Hz converge to the same trajectory — the core bug fix).
2. **Inputs untouched**: thumb drag still maps to an absolute lane target (line ~440),
   keyboard still rate-adjusts the target (line ~847). Only the plant changes: the car now
   *drives* to the target instead of sliding there. Clown-Car lane-bet keeps reading the car's
   x sign; front wheels `setSteer` from the PD steering command; body lean/pitch via the 7E
   `bodyLanguage()` helper, composed with the road-slope pitch.
3. **Racer pose lines replaced** (`main.ts` ~864–887): parked path eases target to 0 through
   the same physics; the `0.12`/`0.18`/`turn*0.36` per-frame constants die.

## Open Questions

None blocking. Track dimensions (straight length, arc radius, lane width) and gear
count `N` are tuning constants to dial in during Phase 1 browser testing.
