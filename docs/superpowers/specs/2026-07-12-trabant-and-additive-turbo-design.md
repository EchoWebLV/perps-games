# Trabant Display Name and Additive Turbo Design

## Goals

- Keep `perpz` unchanged as the regular-progression access code. It grants entry with only the free starter car and no bonus coins.
- Rename the starter car from “Solana Paper” to “Trabant” everywhere players see it.
- Make every Turbo Kit level add 50x above the selected car’s starting leverage ceiling. Cybertruck therefore progresses from 1500x at level 0 to 1550x at level 1 and 2000x at level 10.
- Show the car-adjusted current and next leverage values in the Upgrades panel.

## Approaches Considered

### Starter-car rename

1. **Separate stable identity from display name (recommended).** Keep `Solana Paper` as the persisted inventory and server ID, add an optional player-facing label, and render `Trabant` in the garage cards and details. Existing accounts keep ownership without migration.
2. **Rename the canonical inventory ID.** Migrate local storage and every server inventory row from `Solana Paper` to `Trabant`. This changes database identity for a cosmetic rename and introduces conflict handling for accounts containing both IDs.
3. **Replace the string globally.** This is small but silently creates a second free-car identity and can strand or duplicate existing ownership.

The design uses option 1. The model path remains `/models/trabant.glb`, the stable ID remains `Solana Paper`, and only the display label becomes `Trabant`.

### Turbo interaction with high-base cars

1. **Add the earned Turbo bonus above the larger starting ceiling (recommended).** The formula is `max(global base, car base) + earned turbo bonus`.
2. **Keep the current floor behavior.** The formula remains `max(global base + bonus, car base)`, which makes paid upgrades ineffective on Cybertruck until the global ceiling passes 1500x.
3. **Lower Cybertruck’s base and let upgrades rebuild it.** This removes the car’s advertised 1500x starting perk and changes its balance for new players.

The design uses option 1 because every paid level has an immediate, understandable effect while the 3000x on-chain safety cap remains authoritative.

## Architecture

### Stable car identity and player-facing label

`CarOption.name` remains the stable inventory ID used by persistence, server sync, presence, entitlements, grants, and ownership checks. `CarOption.displayName` is optional and used only for visible garage text and image alternative text. A small display-name helper returns `displayName ?? name` so all player-facing card and detail surfaces agree.

The starter definition becomes:

```ts
{
  name: "Solana Paper",
  displayName: "Trabant",
  url: "/models/trabant.glb",
  // existing fields unchanged
}
```

No local-storage or database migration is required. Existing and new accounts continue owning the same stable starter ID.

### Shared additive leverage calculation

The shared engine entitlement module will expose one pure helper that accepts the upgrade-adjusted global ceiling and optional car base:

```ts
carLeverageCeiling(upgradedRmax, carBaseLev)
  = max(BASE_CONFIG.RMAX, carBaseLev) + max(0, upgradedRmax - BASE_CONFIG.RMAX)
```

Examples:

| Car | Turbo level | Result |
|---|---:|---:|
| Stock | 0 | 1000x |
| Stock | 1 | 1050x |
| Stock | 10 | 1500x |
| Cybertruck | 0 | 1500x |
| Cybertruck | 1 | 1550x |
| Cybertruck | 10 | 2000x |

Both the server-authoritative `perkEnvelope()` and the client’s live `effRmax()` use this helper. Heavy Load and Nitro multipliers remain applied after this ceiling, followed by the existing on-chain clamp.

### Upgrade display

`createUpgrades()` receives an optional leverage-value mapper from the game. For the Turbo row, the current and next raw upgrade ceilings pass through that mapper before formatting. The game supplies its selected-car calculation, so Cybertruck shows `1500x` at level 0 and `1550x` as the next value instead of showing the stock-car `1000x → 1050x` scale.

Other upgrade tracks and callers keep their existing behavior when no mapper is supplied.

## Data and Error Handling

- `perpz` and `magic` remain unchanged.
- Existing `Solana Paper` ownership, duplicate counts, finishes, server inventory rows, trade history, and presence IDs remain valid.
- The additive ceiling is clamped by the existing `ONCHAIN.RMAX = 3000` entitlement boundary.
- Out-of-range upgrade levels continue using the current defensive level clamp.

## Testing

- Garage tests prove `Trabant` is visible while selection callbacks still receive stable ID `Solana Paper`.
- Engine entitlement tests prove Cybertruck is 1500x, 1550x, and 2000x at Turbo levels 0, 1, and 10.
- Client parity tests prove live client math matches the shared server entitlement formula.
- Upgrade UI tests prove the optional selected-car mapper affects both current and next Turbo values.
- Existing access-code tests prove `perpz` still grants only the stable starter car and zero coins.
- Run the complete client and engine test suites plus the production build.

## Out of Scope

- Canonical inventory-ID migration.
- Changing `perpz`, `magic`, Turbo pricing, upgrade level limits, car rarity, model art, or the 3000x on-chain cap.
