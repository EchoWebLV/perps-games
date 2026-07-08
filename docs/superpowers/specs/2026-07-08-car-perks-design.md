# Car Perks — small differentiators for every blank card (design)

**Date:** 2026-07-08
**Status:** approved design, pre-plan
**Owner request:** "small differentiators for all common and uncommon cars… 5 seconds more or less timer, speed a little more or less, or sometimes finding a colorful coin like the synthwave car. I just want all of them to have a small difference. They need to have puns with what the cars are."

## Goal

Every car whose card today shows dead flavor text gets one **tiny, real, always-on perk** whose name and copy is a pun on what the car is. Scope = 6 commons + 3 uncommons + the 2 blank rares (user opted in). Starter stays deliberately stock ("pure drive" is its identity). Hero ability cars (Vaporwave, Cart Rod, Six Wheeler, …) are untouched.

## Principles

1. **EV-neutral on the perp.** No perk touches leverage, liq floor, stake caps, or payout math (`core/rarity.ts` rule: rarity/abilities are never a perp edge). Allowed dials: round *length* (±5s — Six Wheeler's +50% is the shipped precedent, and the program clamps duration ≤180s anyway), road-speed *feel*, soft-coin economy, scrap economy, catch feel.
2. **Class B, client-only.** Wired exactly like Cart Rod / Vaporwave: no program redeploy, no server change.
3. **Small.** Every coin-economy number is at or below Cart Rod's +33% benchmark in expected value; scrap perks may run slightly higher because scrap is cosmetic-only by design (it never buys leverage). Commons get one small tweak; uncommons and rares get a notch more character, not more edge.
4. **Puns are the product.** The card's power name/desc (already rendered by the garage card UI) carries the joke; the perk makes the joke true.
5. **One car equipped at a time**, and perks exist only on ability-less cars → perks and abilities never stack or conflict.

## The perks

### Commons (rarity 1)

| Car | Perk (card name) | Card desc | Effect |
|---|---|---|---|
| Banana | **Peel Out** | "slips between lanes quicker" | swerve accel budget ×1.10 (banana peel = slippery) |
| Cook Wagon | **Let It Cook** | "+5s on the round clock" | round timer +5s (the position cooks longer) |
| Trabbi | **Eventually…** | "−4% speed · +5s clock" | road speed ×0.96 **and** timer +5s (0–60 eventually; the clock waits) |
| Big Frank | **Fast Food** | "it's literally fast food" | road speed ×1.04 |
| Dragon | **Dragon's Hoard** | "some coins land gilded: ×3" | ~1-in-12 coins spawns molten-gold, worth ×3 (dragons hoard gold) |
| Homewrecker | **Demolition Pay** | "every scrap heap +1 point" | scrap heaps bank +1 point (1/3/5 → 2/4/6; wrecking pays) |
| Starter | *(stock)* | "no special ability — pure drive" | none — unchanged, prior decision |

### Uncommons (rarity 2)

| Car | Perk (card name) | Card desc | Effect |
|---|---|---|---|
| Prickle | **Needle Reach** | "spines snag coins wider" | coin catch width ×1.20 (`CATCH_X` 3.2 → 3.84) |
| The Kraken | **Sunken Treasure** | "rarely the deep gives one up: ×5" | ~1-in-25 coins spawns barnacle-teal, worth ×5 |
| Noodler | **Instant Ramen** | "−5s clock · +15% coins" | timer −5s **and** coin density ×1.15 (served scalding — quick and hot) |

### Rares (rarity 3, the two blank cards)

| Car | Perk (card name) | Card desc | Effect |
|---|---|---|---|
| Copycat | **Copycat** | "mimics a random perk each round" | at GO, copies one uniformly-random perk from the 10 other perk cars for that round; toast announces which |
| **Knockoff** (renamed from Knockout) | **Knock 'Em Off** | "chained coins pay ×2 every 2nd" | catches within a ~2.5s window chain; every 2nd chained catch pays ×2 (the one-two rhythm) |

**Rename:** `Knockout` → `Knockoff` — the model is a Hot Wheels knockoff, so the name IS the pun. Verified clean: the display name exists only at `redline3d/src/main.ts:377`; wheel-rig scripts key on the unchanged `knockout.glb` filename; no baked card art; no server references; local/server inventories have never shipped the old name (branch uncommitted) → no migration.

**Expected-value calibration (coin/scrap perks):** Dragon (1/12)·(3−1) ≈ +17% coin value; Kraken (1/25)·(5−1) = +16%; Noodler +15% density on a 5s-shorter round ≈ single-digit net; Knockoff ≤ +50% only while a chain is alive (realistic ≈ +25%); Copycat = the average of its donors. All coin perks sit at or below the Cart Rod benchmark. Homewrecker's +1 pt/heap ≈ +50% scrap points (avg 2.0 → 3.0) — above the coin benchmark on purpose, allowed because scrap is cosmetic-only.

## Data model

```ts
// carpicker.ts — next to CarAbility/CarPower
/** tiny always-on perk for non-ability cars (Class B, client-only) */
export interface CarPerk {
  timeSec?: number;     // ± seconds on the round clock
  speedMult?: number;   // road-speed feel multiplier (0.96–1.04)
  swerveMult?: number;  // lane-change accel-budget multiplier
  coinRate?: number;    // coin density multiplier (setCoinRate seam)
  special?: { chance: number; mult: 2 | 3 | 5; color: number; name: string }; // themed bonus coin
  catchMult?: number;   // catch-width multiplier on CATCH_X
  scrapBonus?: number;  // +points banked per scrap heap
  combo?: boolean;      // Knockoff: every 2nd chained catch pays ×2
  copycat?: boolean;    // Copycat: roll a random donor perk at GO
}
```

`CarOption` gains `perk?: CarPerk`. Each perk car's `power` field carries the pun copy above (replacing the dead flavor text). Icons reuse the existing `ICONS` set: Banana `swerve`, Cook Wagon `clock`, Trabbi `clock`, Big Frank `flame`, Dragon `sparkle`, Homewrecker `weight`, Prickle `target`, Kraken `coin`, Noodler `clock`, Copycat `swap`, Knockoff `bell`.

## Wiring map (every dial is an existing seam)

| Dial | Seam | Change |
|---|---|---|
| `timeSec` | `effMaxSec()` `main.ts:262` | `Math.round(CONFIG.MAXSEC × heavy) + (perk?.timeSec ?? 0)`, floored at 15s; flows into `open()`'s dur as today (program clamps ≤180s) and the frozen `roundMaxSec` |
| `speedMult` | road-speed line `main.ts:1307` | `× (perk?.speedMult ?? 1)` alongside Nitro's `boost` |
| `swerveMult` | lane-drive accel budget (`A_MAX`/auth in `core/lane-drive.ts`) | authority scale parameter, default 1 — race lane-swerve only; strip/freedrive steering untouched |
| `coinRate` | `pickups.setCoinRate` | `setCoinRate(a === "cartRod" ? CART_COIN_RATE : perk?.coinRate ?? 1)` |
| `special` | pickups spawn/recycle + `coinMult` pop machinery | new `setSpecial(spec \| null)`: roll `chance` per coin spawn via the `RandomnessProvider` port (crates convention); special coin gets the fixed theme color + stronger emissive so it reads at speed; on catch, value ×mult and the existing ×N pop fires. Coins only — scrap heaps stay steel. Mutually exclusive with rainbow by construction (rainbow is Vaporwave's ability). |
| `catchMult` | `CATCH_X` in pickups | effective catch width = `CATCH_X × catchMult`; Magnet's `MAG_CATCH_X` untouched (ability-only) |
| `scrapBonus` | scrap banking in pickups collection | banked points = `grade.pts + scrapBonus`; heap visuals stay grade-true |
| `combo` | main.ts collection handling of `CoinHit` | chain = consecutive catches ≤ ~2.5s apart (window tuned in browser); every 2nd chained catch doubles that coin's value and fires the existing ×2 pop |
| `copycat` | GO path in main.ts | roll uniformly among the 10 donor perks (never itself) via `RandomnessProvider`; `applyPerk(donor)` for the round; `hud.setStatus("😼 Copycat: <Car>'s <Perk> today")`; revert at settle/expire |

**Perk lifetime:** perks apply whenever the car is equipped (strip + race), same as Cart Rod's coin rate today — except Copycat's copied perk, which is round-scoped (rolled at GO, cleared at settle); Copycat is stock on the strip.

**Applier:** one `applyPerk(perk?: CarPerk)` in main.ts next to `setAbility()`, called from the same car-select path; both are cheap idempotent setters.

## Testing

- **Vitest units:** `effMaxSec` perk math (+5/−5/floor); speed-mult composition; special-coin roll boundaries with injected RNG (chance edge, mult, coins-only rule); catch-width scaling; scrap bonus banking; chain counter (window keeps chain, gap resets, every-2nd pays ×2); Copycat roll (uniform, excludes self, round-scoped revert); roster integrity (11 perk cars exactly, Starter + ability cars perk-free, `Knockoff` name present / `Knockout` gone).
- **Browser proof (mandatory):** equip each perk car in the garage and verify the visible effect — timer chip value, speed feel, gilded/teal coin visible on the road + ×N pop on catch, wider catch, +1 scrap banking, Knockoff's ×2 cadence, Copycat's GO toast.

## Out of scope

- Starter stays stock; Vaporwave and all ability cars unchanged.
- No server, on-chain, or program changes; no perp-dial effects anywhere.
- No card-art re-bake (power text is DOM; car art renders from the GLB — only Knockoff's display string changes).
- Perk stacking, perk upgrades, or exposing perks in crates odds UI — later if ever.
