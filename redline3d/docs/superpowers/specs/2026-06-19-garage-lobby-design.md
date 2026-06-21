# Parking-Lot Lobby — design

**Date:** 2026-06-19
**Status:** approved-in-dialogue (corrected structure), pending written review
**Branch:** redline-3d

## Summary

Add a **map icon** beside the radio toggle. Tapping it leaves the race and drops you
into the **lobby: one giant 3D neon parking lot you free-roam drive**. Standing in the
lot are **three 3D buildings — Solana, Bitcoin, Ethereum**. You cruise the lot and
**drive into a building to pick that market** — which takes you straight back to the
race set to that asset. The lot is the single hangout; the buildings are the market
entrances. Solo today (an empty lot, just your car), but architected so other players'
cars fill it later with no rewrite.

This reuses the existing car model, environment, and "hold-to-drive" input, and adds
**zero backend and zero new surface to the money/settlement path**. The game already
treats BTC/ETH/SOL as switchable markets (`hud.onAsset`), so "enter building = select
market" is a natural fit.

## Goals

- A map button next to the radio ([`ui/radio.ts`](../../../src/ui/radio.ts)), visible only when out of a round.
- A free-roam drivable parking lot (accelerate / brake / reverse / steer, soft walls).
- Three themed 3D buildings (SOL / BTC / ETH) with neon signage + glowing entrances.
- Drive into a building → select that market and transition to the race for it.
- A back/exit control to leave the lot without changing market.
- A clean, empty **multiplayer seam** so adding real presence later is a data swap.

## Non-goals (YAGNI)

- Real networking / presence server / accounts — **future**, explicitly stubbed.
- Card-picker / menu UI for choosing a market (rejected — the lot *is* the picker).
- Building interiors (each building is an exterior landmark + entrance, no inside room).
- Chat, emotes, voice; car-to-car collision; trading or gameplay inside the lot.
- Showpiece/parked cars or props beyond the three buildings — the lot is otherwise open.
- Persisting lot state across sessions.

## Architecture

### App mode

`main.ts` gains a top-level mode: `"race" | "lobby"`. Only one is active. Both share the
single renderer, scene, camera, and **the one `car` instance** (repositioned per mode).
The `frame()` loop branches:

- `race` — current behavior, unchanged.
- `lobby` — the parking-lot scene is shown, the race world (`world.group`,
  `pickups.group`) is hidden, the lobby camera + free-roam controller run, the race HUD
  is hidden and the lobby HUD shown. Music keeps playing.

Transitions fade via the existing overlay + camera-blend patterns.

### Components

**`ui/mapbutton.ts` (new)** — a panel button matching the radio's style, placed
immediately left of the radio toggle. Map-pin SVG icon (neon line style, consistent
with `carpicker.ts` ICONS). In `race` (out of round) it enters the lobby; it also acts
as the lobby's exit. `setVisible(boolean)` hides it during a live round (same gate as
`garage.setBusy`).

**`core/freedrive.ts` (new, TDD'd)** — the pure, deterministic free-roam kinematics.
The primary testable core.
- State: `{ x, z, heading, speed }`.
- `step(state, input, dt, bounds) → state`, `input = { throttle: -1..1, steer: -1..1 }`.
- Arcade feel: throttle accelerates toward a max speed; coasting applies friction;
  reverse below zero; steering turn-rate scales with speed (no turning when parked);
  position clamped to `bounds` (half-extents), killing into-wall velocity.
- No Three.js import — just numbers. Fully unit-tested (`freedrive.test.ts`).

**`core/lobby-layout.ts` (new, TDD'd)** — pure geometry for the lot.
- Exports the three buildings' positions/sizes + entrance zones, and the lot `bounds`.
- `entranceHit(pos) → "SOL" | "BTC" | "ETH" | null` — which doorway the car is in (if any).
- No Three.js. Unit-tested (`lobby-layout.test.ts`) — both the render scene and the
  main-loop entry trigger consume the same source of truth.

**`render/lobby.ts` (new)** — builds the parking lot as a `THREE.Group` from the layout.
- Floor: a large plane with painted parking-bay lines + a neon grid.
- Soft perimeter walls: a glowing neon boundary (visual; logical `bounds` from layout).
- **Three building meshes** (SOL/BTC/ETH): a simple neon storefront each — body with
  lit-window facade, a glowing sign (glyph + name) in the asset color, and a bright
  doorway at the entrance zone. Themed per asset (SOL teal→magenta, BTC gold, ETH indigo).
- `remoteCars: THREE.Group` — **empty today**. `setRemoteCars(states)` spawns / updates /
  removes ghost cars; the single multiplayer integration seam.
- API: `group`, `show()`, `hide()`, `setRemoteCars(states)`, `update(dt)` (animate neon),
  `dispose()`.

**`render/lobbycam.ts` (new)** — a yaw-aware chase: camera behind + above the car along
its `heading`, looking at it, smooth follow. (The existing `ChaseCam` follows a fixed −Z
road axis, so free-roam needs this dedicated follow.) API: `update(camera, dt, pos, heading)`.

**`ui/lobbyhud.ts` (new, small)** — the lobby's minimal overlay: an **"ENTER {MARKET}"**
prompt shown while the car is in a doorway zone, plus reuse of the existing `joystick`
visual. `setPrompt(asset | null)`, `show()/hide()`.

### Entering a building (market select → race)

Each frame in `lobby` mode: `entranceHit(carPos)` from the layout.
- If in a doorway zone → `lobbyHud.setPrompt(asset)`. After a brief dwell in the zone
  (so you don't trigger by skimming past), commit: set the active `asset` via the
  existing `hud.onAsset` path, fade out, switch `mode → "race"`, restore the race HUD.
  The player lands in the race ready to `GO!` on the chosen market.
- The map/back button exits to race **without** changing market.

### Input (reused)

The existing "hold-anywhere-to-drive" pointer handlers + `joystick` visual are
generalized: in `lobby` mode the same press/drag maps to free-roam `input` (hold = gas,
drag back past threshold = brake→reverse, drag left/right = steer) feeding `freedrive`.
The race mapping is untouched.

### Multiplayer-ready seam

```ts
export interface RemoteCarState { id: string; x: number; z: number; heading: number; model?: string }
lobby.setRemoteCars(states: RemoteCarState[]): void  // called with [] today
```

Later, a presence feed maps to `RemoteCarState[]` each tick and calls `setRemoteCars`.
Nothing else in the client changes. No presence code ships now.

## Render-loop branch (main.ts)

```
frame():
  dt = clamped delta
  if mode === "lobby":
    input = readDriveInput()                      // hold-to-drive, lobby mapping
    drive = freedrive.step(drive, input, dt, lobbyLayout.bounds)
    place car at drive (x, z, heading)
    hit = lobbyLayout.entranceHit(drive)          // SOL | BTC | ETH | null
    lobbyHud.setPrompt(hit); if (hit dwell) selectMarket(hit) -> mode="race"
    lobby.update(dt); lobby.setRemoteCars([])
    lobbycam.update(camera, dt, drive, drive.heading)
    render
  else:
    …existing race/idle path, unchanged…
```

## Testing

- **Unit (TDD):** `core/freedrive.test.ts` — acceleration, coast friction, reverse,
  speed-scaled steering, bounds clamp (no escaping the lot, into-wall velocity zeroed).
- **Unit (TDD):** `core/lobby-layout.test.ts` — `entranceHit` returns the right asset
  inside each doorway and `null` elsewhere; buildings sit inside `bounds`.
- **Manual / preview:** map button shows only out of round; race → lot transition;
  drive feel + walls; the three buildings + signage; driving into a building lands you
  in the race set to that market; back button returns without changing market.

## File plan

| File | Change |
|------|--------|
| `src/core/freedrive.ts` | NEW — kinematics |
| `src/core/freedrive.test.ts` | NEW — TDD |
| `src/core/lobby-layout.ts` | NEW — building/entrance geometry + `entranceHit` |
| `src/core/lobby-layout.test.ts` | NEW — TDD |
| `src/render/lobby.ts` | NEW — parking lot scene + 3 buildings + remoteCars seam |
| `src/render/lobbycam.ts` | NEW — yaw-aware follow cam |
| `src/ui/mapbutton.ts` | NEW — map icon (enter lobby / exit) |
| `src/ui/lobbyhud.ts` | NEW — ENTER prompt + joystick reuse |
| `src/main.ts` | EDIT — mode race\|lobby, frame branch, input routing, market-select→race, HUD show/hide, wiring |
| `src/ui/radio.ts` | EDIT (small) — shift to make room for the map button |

## Risks / notes

- **Biggest new piece** is the free-roam controller + follow cam; the kinematics and the
  entrance geometry are both isolated as pure, tested modules to de-risk.
- Keep the lot light (floor, neon walls, three simple buildings, lighting) to protect
  the Seeker APK footprint + load time per the asset/perf constraints.
- A big empty lot can read as *too* empty solo; theme lighting, the three lit buildings,
  and a tuned (not endless) lot size keep it feeling like a place. Tune bounds in build.
- Entrance trigger needs a small dwell/debounce so you don't enter a market by skimming
  past a doorway at speed.
