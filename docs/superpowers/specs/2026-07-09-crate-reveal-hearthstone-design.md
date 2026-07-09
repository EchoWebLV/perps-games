# Crate reveal — Hearthstone-style "all prizes on one screen"

**Date:** 2026-07-09
**Branch:** intro-clarity
**Status:** design — awaiting approval → implementation plan

## Goal

Turn the crate-open **reveal** into a pack-opening moment where every prize from a single
open is shown together on one screen, each rendered by its type:

- a **car** → a spinning 3D model (the hero)
- a **level/world-skin unlock** → a collectible card
- **scrap** → a little pile

The reference is a Hearthstone pack open: a satisfying burst, then the loot laid out at once.

## Scope

**Changes:** only the *reveal* — `showReveal` and the opening choreography in `doOpen`
(`ui/cratebox.ts`), plus a new self-contained 3D car viewer and small render helpers.

**Unchanged:** the crate shop grid, buy/again flow, coin spend, and all roll logic
(`core/crate.ts`: `rollCrate` / `dupeScrap` / `pickLevel`). A single open still yields exactly
what it does today — one car (new→unlock / dupe→bonus scrap), guaranteed crate scrap, and an
occasional level-skin drop. We only re-skin the payload.

## What a single open produces (today, unchanged)

1. **Car** — `rollCrate(...)`. `grantCar` returns `isNew`; a dupe adds `dupeScrap(rarity)`.
2. **Scrap** — always `crate.scrap` (+ dupe bonus). One integer.
3. **Level skin** — sometimes: `pickLevel(lockedLevels, crate.levelChance, …)` → a key or null.

## The three renders

### Car — the hero (always shown)

A **live spinning 3D model** on a turntable, centered and largest. Tier-colored halo + rim
lights; slow auto-rotate. Below it: a `NEW` badge (fresh unlock) or `DUPLICATE` badge, the tier
name, rarity gems, and the car name.

**Model source:** the rolled car object is a `CAR_DEFS` entry and already carries `url`, `scale`,
`yaw` at runtime (main.ts does `car.setModel(c.url, c.scale, c.yaw)`). Widen the `CrateCar`
interface with optional `url?/scale?/yaw?` so the viewer can read them truthfully — no new deps
plumbing, no name→glb map.

**Tier handling (per approved decision):**
- **High tier** (`quality.tier === "high"`): a live persistent `WebGLRenderer` canvas, GLB on a
  rotating pivot, tier rim lights, RoomEnvironment envMap for metal (same as the garage
  showroom). rAF auto-rotate while the reveal is up.
- **Low tier** (`quality.tier === "low"`, i.e. Seeker/weak GPU): **no live canvas** — render the
  model to a single PNG once (reuse the transient-renderer pattern already in `cratebox.ts`'s
  `renderCrates3d`) and show it as a static `<img>`. Zero live GPU during the reveal.

Either way the viewer is a **small canvas (~200px), pixel-ratio capped**, and is **disposed when
the crate overlay closes** (GL context freed).

### Scrap — a little pile (always shown)

A **procedural** cluster of steel shards (no scrap GLB exists — only cars + the 3 crate GLBs),
in the scrap-chip color `#c2cad6` family, with `+N` and a `scrap` label. Pure HTML/CSS/SVG.
Optional flourish: shard count nudges up with the amount so a Gold open (+800) reads heftier
than a Wooden (+25) — a small pure mapping, unit-testable.

### Level skin — a card (only when the roll hits)

A **mini world-poster** built from the theme's real palette: a flat sky color, a sun/moon disc,
a couple of neon grid lines, the skin name, and a `NEW LEVEL` tag. A real collectible card, not
today's flat two-color chip.

**Data:** widen `deps.levelInfo(key)` (wired in main.ts from `render/world-themes.ts THEMES`) to
return `{ name, sky:[hi,lo], disc, grid:[a,b] }` instead of `{ name, colors[] }`. All fields
exist on `WorldTheme` (`sky`, `celestialColors`, `grid`).

## Layout & choreography

**Layout (one screen):** car hero top-center; a secondary row beneath holds the scrap pile
(always) + the level card (only if dropped). When no level dropped, the scrap tile centers.
Done + "Open again" buttons at the bottom (as today).

**Choreography (the build-up):**
1. crate shakes (existing `cbShake`)
2. bursts with a tier-colored flash (existing `cbBurst`/`cbFlash`) — **bigger burst + halo for
   rarer tiers**
3. the car spins into view as the hero
4. the scrap pile and level card **pop in staggered** (existing `cbScrapIn`/`cbCardIn` timing)
5. everything rests together on one screen

Reuse the current timings (500ms shake → 230ms burst → reveal) so it feels tuned, not slower.

## Module plan (small, bounded units)

1. **`src/ui/reveal-car.ts` (new)** — `createRevealCar({ lowTier })` →
   `{ el, show({url,scale,yaw,tierColor}), clear(), dispose() }`. Owns the WebGL lifecycle
   (live turntable on high tier; one-frame PNG on low tier). Single purpose, testable boundary,
   keeps `cratebox.ts` from ballooning.
2. **`src/ui/cratebox.ts` (edit)** — re-skin `showReveal` to compose viewer + scrap pile + level
   card + nameplate; update `doOpen` choreography; mount/teardown the viewer with the overlay;
   accept a new `lowTier` dep. Small pure helpers `scrapPile(n)` and `levelPoster(info)` (inline
   or a tiny `reveal-bits.ts`).
3. **`src/core/crate.ts` (edit, minor)** — widen `CrateCar` with optional `url?/scale?/yaw?`.
4. **`src/main.ts` (edit, minor)** — pass `lowTier: quality.tier === "low"`; enrich `levelInfo`
   to return the poster palette from `THEMES`.

## Testing & verification

- Existing `crate.test.ts` / `rarity.test.ts` stay green (roll logic untouched).
- Add focused unit tests only for any **pure** helper introduced (e.g. `scrapPile` shard-count by
  amount; tier→burst-size). The reveal itself is visual → **browser-verified** in Claude Preview.
- Browser check must exercise **all three tiles at once**: force a **NEW legendary + a level
  drop** (inject a deterministic `deps.rng`, or bias draws in a dev harness) and screenshot; then
  a **duplicate** (badge + bigger scrap, no level); confirm the **low-tier static-car** path via
  `?perf=low`. DEV entry: `__hw.triggerBuilding('crates')` opens the shop.
- `tsc --noEmit` clean; full suite green.

## Non-goals

- No change to drop odds, prices, scrap economy, or the level-skin unlock system.
- No new car/scrap 3D assets.
- No real-money ($) wiring (still stubbed).
- The Scrap Yard sink stays "coming soon" — untouched.
