# Scrap Yard & Scrap Economy — Design

**Date:** 2026-07-07
**Status:** Approved in brainstorm; pending spec review
**Scope:** Give the earned `scrap` currency a real sink (the Scrap Yard) and turn duplicate cars into a meltable resource, closing the earn→spend loop. Devnet / client-side only.

## Goal

Scrap is currently an **earn-only** currency — caught while driving and paid out by crates, but with nowhere to spend it (tapping the Scrap Yard just toasts "coming soon", [main.ts:635](../../../redline3d/src/main.ts)). This makes the whole earn loop feel hollow. This work builds the Scrap Yard so scrap has a purpose, and reworks duplicate cars into a stackable, meltable resource that feeds it.

## The loop

```
drive + open crates ──► scrap
duplicate cars ──► stack (×N) ──► melt spares ──► scrap
scrap ──► Paint Shop (cosmetics) ──► [dead end]
```

**Scrap is a terminal cosmetic currency.** It never converts back into coins, cars, or leverage. Because it is a dead end, there is **no arbitrage loop** — a player can never melt→re-pull for profit. This property is what keeps the economy safe, and it is a hard constraint (see Constraints).

## Locked decisions

1. **Counted collection.** Car ownership moves from own/not-own to owning **N copies**.
2. **Non-destructive melt.** You can only melt **spare** copies — every car keeps a floor of **≥1**. Melting never removes a car from the collection. Consequences: no confirm dialogs needed, and the Starter + equipped car are safe *by construction* (they are always the last copy).
3. **Dupes stop auto-paying scrap.** Today a duplicate pull instantly adds `dupeScrap()` ([cratebox.ts:249](../../../redline3d/src/ui/cratebox.ts)). After this change, a duplicate pull instead **increments the stack**; the same scrap value is realized later by melting the copy. Value preserved, deferred, and made manual — which is what gives the Scrap Yard foot traffic.
4. **Melt value = the existing rarity scale** `{Common 3, Uncommon 6, Rare 12, Epic 25, Legendary 50}` (`DUPE_SCRAP` in [crate.ts:50](../../../redline3d/src/core/crate.ts)), reused so nothing inflates.
5. **The sink is cosmetics — launch item: Golden Paint** + a small paint palette, applied per-car and shown in the garage and the race.

## Components (isolated units)

Each unit below is independently testable; pure logic is separated from DOM/render.

### 1. Counted inventory — `core/inventory.ts` (refactor)

Current: `createInventory(key, free)` backs a `Set<string>` persisted as a JSON array of ids ([main.ts:345](../../../redline3d/src/main.ts) — `createInventory("redline.owned.v1", ["Starter"])`).

New shape — a counted store:

```ts
interface CountedInventory {
  owns(id): boolean;              // count(id) > 0
  count(id): number;              // 0 if never pulled
  grant(id): boolean;             // increment; returns newlyOwned (0→1). SAME signature/semantics as today — non-breaking.
  spares(id): number;             // max(0, count - floor)   (floor = 1 for owned)
  melt(id): boolean;              // decrement iff spares(id) > 0; else no-op false
  all(): string[];                // ids with count > 0
  meltableSpares(): { id, count }[]; // ids with spares > 0
}
```

- **Non-breaking `grant`:** the current `grant` already returns `true` = newly owned / `false` = duplicate. We keep that exact boolean signature and just increment a count internally, so no call site breaks (cratebox branches on it; levels ignores it). Only `count`/`spares`/`melt`/`meltableSpares` are additive.
- Ids are the car's **`name`** (e.g. `"Starter"`) — the same key the roster and inventory already use. `finishes` (unit 4) is keyed by the same id.
- **Floor rule:** an owned car cannot go below 1. `free` ids (Starter) behave identically — they simply can never be melted because they never have a spare unless pulled again.
- **Migration:** the old persisted value is a JSON array of ids. On load, if the parsed value is an array → convert to `{ [id]: 1 }`. New persisted value is a `Record<string, number>`. Detect shape at load; no data loss for existing players.
- `levels` inventory ([main.ts:347](../../../redline3d/src/main.ts)) also uses `createInventory` but never needs counts — it keeps calling `grant`/`owns`/`all` unchanged.

### 2. Melt valuation — `core/scrapyard.ts` (new, pure)

```ts
meltValue(rarity?): number            // DUPE_SCRAP scale, reused
meltAllValue(spares: {rarity, count}[]): number   // sum
```

### 3. Paint catalog + pricing — `core/paint.ts` (new, pure)

- A finish set: `gold` (Golden Paint) + a starter palette of colors.
- `paintPrice(rarity, finishId): number` — scales with the car's rarity (gilding a Legendary costs more than a Common). **Starting numbers, to be tuned by playtest, not asserted as balanced:** Golden Paint `{Common 150, Uncommon 250, Rare 450, Epic 800, Legendary 1500}`; palette colors a flat cheaper tier. Rationale for the ballpark: driving heaps + crate base scrap (25/300/800) are the primary funding, melt is supplementary; low-hundreds prices make a first gild reachable within a few sessions without being trivial.

### 4. Scrap spend + applied finishes — `ui/upgrades.ts` (extend)

The garage save `redline.garage.v1` is `{ coins, scrap, levels }` with `scrap()` / `addScrap()` already present. Add:

```ts
spendScrap(n): boolean;               // mirror of the coin spend(): debit iff affordable, persist, fire onScrap
finish(carId): string | undefined;    // applied finish for a car
setFinish(carId, finishId): void;     // persist
```

- Extend `Saved` with `finishes: Record<string, string>` (default `{}`), loaded/persisted alongside the rest.
- **Paint model:** buying a finish for a car spends scrap and applies it immediately (`spendScrap` + `setFinish`). Re-painting another car costs again (per-car purchase = a repeatable sink). *Alternative considered:* own-a-color-once, apply free — rejected for launch as a weaker sink; revisit if paint feels too grindy.

### 5. Crate opener — `ui/cratebox.ts` (change)

- On a duplicate pull, **do not** add `dupeScrap`. Instead the stack increments (via `grant`, which now counts) and the reveal shows the new count (e.g. "DUPLICATE — now ×3"). The base crate scrap (25/300/800) is unchanged.
- Uses `grant(id)` (true = new car → NEW reveal; false = duplicate → "now ×N", `count(id)` for the number).

### 6. Garage card — `ui/carpicker.ts` (extend)

- Show a `×N` badge on owned cars whose count > 1.
- Show the applied finish (a swatch / gilded treatment) on the card.
- (Melting itself lives in the Scrap Yard screen, not the card — keeps the card about selection/equip.)

### 7. Scrap Yard screen — `ui/scrapyard.ts` (new)

An overlay opened from the lobby Scrap Yard building, two sections:

- **Melt Bay** — lists cars with spare copies (`meltableSpares()`), each meltable individually, plus a **"Melt all duplicates → +N scrap"** button (`meltAllValue`). Melting calls `inventory.melt(id)` + `upgrades.addScrap(value)` and refreshes.
- **Paint Shop** — pick an owned car, choose Golden Paint or a palette color, see the price (`paintPrice`), buy with `spendScrap` → `setFinish` → the car shows the finish. Buttons disable when scrap can't cover the price (mirror the upgrades panel's affordability gating).

### 8. Car render finish — `render/car.ts` (extend) — **needs confirmation**

Applying a finish must tint/override the car's material so paint shows in the garage and the race. **Risk / open question:** the GLB models may have baked materials; a clean tint hook needs to be confirmed in `car.ts` (`setModel` / a new `setFinish`) during planning rather than assumed trivial. If a clean per-material override isn't available, the fallback is a limited finish set that the renderer can reliably apply (e.g. an emissive/color multiply on the body mesh).

### 9. Wiring — `main.ts`

- Replace `case "scrapyard": lobbyHud.toast(...)` ([main.ts:635](../../../redline3d/src/main.ts)) with opening the Scrap Yard screen, passing the counted inventory, the upgrades store, and the car roster (`CAR_DEFS`).
- Update the `grantCar` callback ([main.ts:441](../../../redline3d/src/main.ts)) and the crate reveal to the counted `grant` return.
- Apply the equipped car's saved finish when it loads (`car.setModel` path, [main.ts:392](../../../redline3d/src/main.ts) + garageRoom).
- Fix the stale CRATES label *"Loot crates — coming soon"* ([lobbyhud.ts:19](../../../redline3d/src/ui/lobbyhud.ts)) as part of the same consistency pass (the opener is live).

## Testing

TDD the pure units first:
- **Counted inventory:** grant increments + `newlyOwned` transition; melt decrements only above the floor; melt at floor is a no-op; migration from a legacy id-array; free items floor.
- **Melt valuation:** per-rarity value; `meltAllValue` sums a spare set.
- **Paint pricing:** scales by rarity; unknown finish/rarity defaults safely.
- **spendScrap:** debits when affordable; no-op + false when not; persists.

Then verify in the browser (the real "does it feel like a game" test): pull dupes → see ×N → melt at the Scrap Yard → buy Golden Paint → see the car change, in garage and race.

## Constraints & guardrails

- **Scrap never buys leverage, coins, or cars.** Cosmetic terminal currency only. (Standing rule from the economics work.)
- **Melt is spares-only, floor ≥1** → non-destructive; Starter + equipped safe by construction.
- **No player-to-player marketplace** — the Kintara commodity-market model needs a backend + multiplayer; parked, not this.

## Out of scope (YAGNI for this pass)

- Additional cosmetics (fire-trail colors, underglow, rims) — natural follow-ons once the paint loop feels good.
- Real-money paint / VRF — behind the existing deferred payment + randomness ports.
- NFT interplay — **forward-compat note only:** when cars become NFTs, a "copy" maps to an additional token and "melt" maps to a burn; the counted model is the right shape for that, but nothing on-chain is built here.

## Risks / open questions

1. **Car finish rendering** (unit 8) — the one genuine unknown; confirm the material seam in `car.ts` before committing to the full palette.
2. **Dupe-feel change** — removing instant dupe-scrap trades a small dopamine hit for agency + hub traffic. Conscious, approved; watch it in playtest.
