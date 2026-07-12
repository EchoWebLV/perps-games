# Asset Price Switch Design

## Goal

Switch BTC, ETH, and SOL without carrying the previous asset's price into a new round. Remove all price-driven road elevation and sudden-move shock effects.

## Design

- Cache the latest real tick for every subscribed asset.
- On a tab switch, atomically replace the active price with that asset's cached real tick. If none exists, clear the active price and keep real-money GO disabled until its first tick.
- Reset the display smoothing and fallback price so no previous-asset value survives the switch.
- Keep raw active-asset prices as the economics input.
- Run the race road at neutral grade and remove the market pulse, shock ring, flash, camera shake, lighting pulse, and debug effect wiring.

## Verification

- Unit-test atomic price replacement and invalidation.
- Regression-test the main asset-switch wiring and absence of price-driven effects.
- Run the full suite and production build before rebuilding the APK and deploying.
