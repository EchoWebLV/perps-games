# Highway Mode — Free-Drive Perps on an Oval Track

**Date:** 2026-07-02
**Branch:** `onchain-er-rebuild`
**Status:** Design — approved, pending spec review

## Summary

A third game mode for Perps Raider, alongside the endless-road **racer** and the
**lobby** economy hub. On a real, static **oval highway** — a *divided* road with a
median, two lanes per carriageway, and traffic running opposite ways on each side —
the player drives freely and *the driving is the trade*: which way you travel around
the loop is your long/short direction, and how fast you go is your leverage (up to
**100×**; the ladder floors at the program's 10× minimum). Other
players appear as non-colliding **ghost cars** on the same track. The on-chain
program is **untouched** — money, settlement, the Lazer feed, and the crank stay
exactly as they are today; only the *input layer* mapping driving → position is new.

## Goals / Non-Goals

**Goals**
- A drivable oval built from a *real static world* (like the lobby), not the
  racer's scrolling-shader illusion — so ghost cars share a coherent coordinate space.
- Driving controls the trade: direction-of-travel = long/short, speed = leverage
  (a gear ladder from the program's 10× floor up to 100×).
- A divided highway: two lanes per carriageway, median between, opposite directions
  per side. Crossing to the oncoming carriageway and committing = reversing your
  travel = an on-chain FLIP of the position.
- Ghost presence: see other players' cars, no collisions, no gameplay interaction.
- Reuse the existing round machinery wholesale: `game-session`, `RoundEngine`,
  `lever-sync`, `flip`, `controls` (GO / CASH OUT).

**Non-Goals**
- No changes to the on-chain `raider` program (no redeploy, no migration).
- No collisions, no shared authoritative state, no PvP outcomes — ghosts are cosmetic.
- No pit-lane cash-out mechanic. Open = GO button, close = CASH OUT button.
- Which of the two lanes *within* a carriageway you sit in is positional/cosmetic in
  v1 — it does not affect risk or leverage. (Which *carriageway/side* is the direction.)
- Not the racer's 2000× ceiling: this mode is capped at 100×.

## Architecture

A new `mode: "highway"` value threaded through `main.ts` beside `"race" | "lobby"`.
Entered from the lobby via a new **HIGHWAY** gate (the existing **Track** gate keeps
launching the classic racer). The world, physics, and camera reuse proven lobby
pieces; only the track geometry and the trade-mapping are new.

```
lobby ──(HIGHWAY gate)──▶ highway ──(exit / CASH OUT settle)──▶ lobby
                              │
                       drive (freedrive.step)
                              │
                 ┌────────────┴─────────────┐
                 ▼                            ▼
        track.progress(x,z)          highway-gears(speed)
        → s, lateralOffset,          → gear → leverage(10..100)
          tangentHeading, dir                  │
                 │                              ▼
                 ▼                     session.noteLeverage(lev)   [lever-sync coalesces]
        dir change (debounced)                  │
                 └──────────▶ doFlip(dir) ──────┴──▶ on-chain flip()/lever()
```

### Components (each isolated + independently testable)

1. **`src/core/track.ts`** — *pure geometry, no THREE / no DOM.*
   Defines the oval **centerline** (two straights joined by two 180° arcs) with an
   arc-length parameter `s ∈ [0, L)`. Exports:
   - `progress(x, z, prevS): { s, lateralOffset, tangentHeading }` — projects a world
     point to the nearest point on the centerline. `lateralOffset` is signed distance
     from centerline (which lane/side); `tangentHeading` is the track's forward yaw there.
   - `contain(x, z): { x, z, hitWall }` — clamps a point to the drivable ribbon
     (inner median edge ↔ outer barrier), returning the corrected position. Replaces
     `freedrive`'s rectangular `Bounds` clamp for this mode.
   - `progressDir(prevS, s): 1 | -1 | 0` — sign of arc-length change = are you going
     *with* the track (LONG, +1) or *against* it (SHORT, −1); 0 when ~stationary.
   - `spawn(): DriveState` — a start pose on the track, facing the forward tangent.
   Design note: an oval's two arcs mean absolute heading is *always* changing, so
   long/short is defined by **tangential progress (`ds`)**, never by absolute heading.
   That is what keeps normal cornering from registering as a flip.

2. **`src/core/highway-gears.ts`** — *pure mapping, no THREE / no DOM.*
   - `gearOf(speedFrac): number` — maps |speed|/MAX_FWD into `N` discrete gears with
     **hysteresis** (upshift/downshift thresholds differ) so leverage doesn't flicker
     at a boundary.
   - `levOf(gear): number` — gear → leverage on a ladder spanning `[MIN_LEV=10, 100]`
     (10 is the program's floor; a stopped car is a live 10× position, top gear = 100×).
   - `flipGate`: a small state machine that only emits a direction change once
     `progressDir` has held the *opposite* sign for `≥ FLIP_HOLD_MS` **and** speed is
     above a floor — debounces corner/parking twitch so a flip is always deliberate.

3. **`src/render/oval.ts`** — *the THREE world* (mirrors `render/lobby.ts` structure).
   Builds the ribbon (two straights + two arcs), painted lane lines, a raised median,
   outer barriers, neon lighting, plus a `remoteGroup` + `setRemoteCars(states)` ghost
   renderer identical in shape to `lobby.ts`. `show()/hide()/update(dt)/dispose()`.

4. **`src/main.ts` wiring** — `enterHighway()/exitHighway()` (guarded like `enterLobby`:
   refuse while a round is `live`), a `mode === "highway"` branch in `frame()` that:
   drives with `freedrive.step` but swaps the rectangular clamp for `track.contain`;
   feeds `track.progress` → gears → `session.noteLeverage`; feeds `flipGate` → `doFlip`;
   renders via `oval` + `lobbyCam`. GO / CASH OUT are the existing global handlers —
   the only highway-specific change is clamping the opened leverage to `[10, 100]`.

5. **`src/net/presence.ts` + `server/presence.mjs`** *(Phase 2)* — a ~100-line Node
   WebSocket fan-out (deployed to Railway) and a thin browser client. Broadcasts
   `{ id, x, z, heading, dir }` a few times a second; feeds `oval.setRemoteCars`.
   No auth — positions are cosmetic and all money is on-chain. Disconnect just freezes
   or drops ghosts; it can never touch a round.

## Data Flow (one highway frame)

1. Read input (touch drag / WASD) → `freedrive.step(drive, {throttle, steer}, dt)`.
2. `track.contain` keeps the car on the ribbon (kills speed on wall contact).
3. `track.progress(x, z, prevS)` → `{ s, lateralOffset, tangentHeading }`; `prevS ⇒ ds`.
4. `progressDir(prevS, s)` → intended long/short; `flipGate` debounces it; on a confirmed
   change while `roundActive`, call `doFlip(dir)` (existing single-flight on-chain flip).
5. `gearOf(|speed|/MAX_FWD)` → `levOf` → `lev`; set `game.lev` (instant local feel via
   `RoundEngine`) and `session.noteLeverage(lev)` (lever-sync coalesces the on-chain send).
6. Render car at `(x, z, heading)`, `oval.update(dt)`, `oval.setRemoteCars(...)`, `lobbyCam.update`.

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
- **Flip safety:** at up to 100× a flip is a real fill; `flipGate` requires a sustained,
  above-speed reversal so cornering and low-speed wiggle never fire one.
- **Gear flicker:** hysteresis in `gearOf` prevents rapid lever churn at a threshold;
  `lever-sync` already coalesces to latest-wins with at most one send in flight.
- **Presence loss (Phase 2):** WS drop → ghosts freeze/vanish; round untouched.
- **Stationary car:** valid live 10× position; the crank still governs time/liq.

## Testing

- **Unit (pure, TDD):** `track.ts` — projection accuracy, lateral sign per lane, `s`
  wrap at the seam, `progressDir` sign, `contain` clamp on straights vs arcs.
  `highway-gears.ts` — monotonic gear ladder, clamp to `[10,100]`, hysteresis (no
  flicker across a boundary), `flipGate` fires only on sustained above-speed reversal.
- **Browser (devnet, mandatory before "done"):** load the real game, enter HIGHWAY from
  the lobby, GO → drive the loop and watch `×`/leverage track speed, do a deliberate
  U-turn and confirm an on-chain FLIP fills, CASH OUT settles, End undelegates clean.
  Phase 2: two browser clients see each other's ghost.

## Phasing

- **Phase 1 — Solo highway (ship first):** `track.ts`, `highway-gears.ts`, `render/oval.ts`,
  the lobby HIGHWAY gate, the `main.ts` mode + trade-mapping, 100× clamp. Browser-verified on devnet.
- **Phase 2 — Ghosts:** `server/presence.mjs` relay (Railway) + `net/presence.ts` client +
  `oval.setRemoteCars` broadcast loop. Browser-verified with two clients.

## Open Questions

None blocking. Track dimensions (straight length, arc radius, lane width), gear count `N`,
and `FLIP_HOLD_MS` are tuning constants to dial in during Phase 1 browser testing.
