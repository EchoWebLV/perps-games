# Identity Economy Persistence Design

## Goal

Keep coins and scrap across login and logout while preserving separate guest and account economies. Show both balances in the driving lobby.

## Design

- Treat the guest as a stable local save namespace instead of disposable live state.
- Before a guest starts account authentication, checkpoint all guest progress under that namespace. This must happen before server hydration can replace the live economy.
- Account state remains authoritative on Railway. The existing account hydrate continues to overwrite the local account cache with server truth.
- On logout, checkpoint the account cache, clear the live identity keys, restore the guest checkpoint, then reload into the identity gate.
- If no guest checkpoint exists, logout correctly returns to a fresh guest economy.
- Keep the current coin and scrap counter components mounted and visible in both lobby cruise and race modes.
- In the lobby, place coins immediately below the SOL balance and scrap immediately below coins. Restore the below-graph positions on the race screen to avoid covering the chart.

## Verification

- Unit-test guest and account namespace isolation with distinct coin and scrap balances.
- Source-level regression-test the required ordering around account hydration and logout.
- Regression-test that lobby chrome keeps both counters visible.
- Run the full test and production build suites before deployment.
