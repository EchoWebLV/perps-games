# Slopwheels: gacha collection home — design

2026-07-24. Approved via brainstorm Q&A. Turns the game into a collection-first gacha
storefront: the player's car collection is the hub; races and the lobby are destinations
you send a car to. Brand: **Slopwheels**.

## Decisions (user-approved)

- **Home screen** = 2D collection UI, boots first. No 3D world constructs before home.
- **Scope** = accelerator-demo loop, client-side. Fake-$ betting stays; server economy,
  real pools, and matchmaking are later plans.
- **Entry reward** = rake-share podium: top-3 finishing car owners split a slice of the
  betting pool's 5% rake. House still cannot lose.
- **Garage** stays in the lobby as a flavor building, unchanged. Home does not replace
  lobby internals.
- **Rebrand** = Slopwheels, applied to the new surfaces only (loadscreen, home header,
  page title). Full brand sweep is out of scope.
- Standing decisions that still hold: races are simulated (car stats + randomness, no
  market data); betting is pari-mutuel with 5% rake; owning cars gates race ENTRY only —
  anyone can bet; perps remains mode 2, reached through lobby buildings.

## Player flow

```
boot → Slopwheels loadscreen → access/identity gates (unchanged order) → HOME
HOME ─ Collection tab: owned car cards + locked silhouettes
│        └ tap car → [Enter race] [Drive lobby] + stats/perk
├─ Store tab: crate shop (3 tiers, welcome crate, VRF rolls, reveal, dupes→scrap)
├─ [Watch & bet]: spectate an all-house-cars race, betting only
├─ [Enter race] → race scene: your car + 7 house cars → bet pre-race → cinematic race
│        → settlement (bets + owner podium) → results → back to HOME
└─ [Drive lobby] → equips the car, builds the town → perps buildings as today
```

## Architecture

**Boot (`main.ts`).** Introduce `home` as the boot mode. Wrap world construction in
memoized `ensureLobby()` / `ensureRace()` builders that run on first entry; returning to
home keeps them warm (no rebuild, no teardown churn). Access gate, identity gate,
DEV_UNLOCK bypass, save restore, and bfcache handling keep their current order — the
lobby simply stops being constructed underneath them.

**Loadscreen.** New small DOM module (`ui/loadscreen.ts`), shown immediately at boot,
progress driven by the real boot promises (models manifest, save restore, identity) —
honest progress, not a fake bar. Acid-green-on-black Slopwheels wordmark; CSS text
fallback until the logo asset lands in the repo (asset must come from the user — the
logo currently exists only as a chat image).

**Home UI.** New module (`ui/home.ts`). Renders from sources the game already trusts:
`CAR_DEFS`, `inventory.owns()`, baked card art. Rarity-sorted owned cards plus locked
silhouettes for unowned cars. [Drive lobby] equips via the same `car.setModel` path
carpicker uses, then `ensureLobby()`. Carpicker and the hamburger menu stay as-is inside
the lobby. The Store tab mounts the existing cratebox flow (VRF, reveal, scrap-melt
unchanged) — new front door, same mechanics.

**Race mode.** Extract `createRaceMode()` from the prototype: the modules
(`race-track`, `race-director`, `race-environment`, `race-hud`, `bet-panel`,
`cam-controls`) mount into the main app's renderer/loop the way highway/track modes do,
parameterized by the grid instead of the hardcoded 8 cars. Grid = equipped car + 7 house
cars drawn from the roster; [Watch & bet] passes a grid of 8 house cars (no owned entry).
The race scene stays warm across entries within a session; what gets disposed per race
is the swapped car models (grid changes), via the reclaim pattern below. Race stats derive from existing car defs via one mapping
table (rarity/perk → pace/surge params), tuned once. Outcome is local RNG in demo; VRF
is a noted upgrade path, not built. `race-preview.html` survives untouched as the dev
harness.

## Economy constants (demo)

- Betting wallet: fake, session-scoped, resets to $100. Never touches real balances or
  the server economy.
- Pari-mutuel settlement: existing verified math, unchanged.
- Rake: 5% of pool. Owner podium pool = 40% of rake, split 50/30/20 across the top-3
  finishers' owners. All constants live in one config and are trivially tunable.

## Data & persistence

Nothing new persists. Home reads the existing identity-scoped inventory; the equipped
car already saves. Betting wallet resets each session. Car win records / form guides:
explicitly deferred.

## Error handling

- Race entry respects `modeSwitchBlocked` (no entering a race mid-perps-round).
- Failed car GLB → existing fallback wedge, race proceeds.
- Per-race car-model swaps (and any full race-scene teardown) use the
  `reclaimToonVariants` dispose pattern (commit ef605d7); builds on the in-flight
  sibling-scene leak-fix task rather than duplicating it.
- Settlement must fire correctly under hidden-tab timer throttling (the `__warp`
  lesson); covered by a test, not by hoping.

## Testing & verification

- Unit: grid assembly (equipped + 7 house), stats-mapping table, owner-podium split
  verified to the cent alongside the existing pari-mutuel tests, throttled-settlement.
- Full vitest suite and `tsc --noEmit` stay green.
- Browser proof (standing rule — UI verified live before "done"): boot → loadscreen →
  home; pull crate → card appears; enter race → own car on grid → bet → settles to the
  cent; drive lobby; classic/toon style toggle flips both ways.

## Out of scope

Server-authoritative entries and real pools; matchmaking real players' cars; VRF race
outcomes; win records/form guides; full rebrand sweep (landing page, README, domain);
any change to real-money balances or the perps economy; garage changes.
