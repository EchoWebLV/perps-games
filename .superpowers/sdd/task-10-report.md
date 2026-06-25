# Task 10 Report

## Status

Pass

## Changed files

- `package.json`
- `package-lock.json`
- `server/package.json`
- `server/src/env.ts`
- `server/src/http/routes.ts`
- `server/src/index.ts`
- `server/src/services/withdraw-worker.ts`
- `server/src/services/withdraw-worker.test.ts`
- `server/src/solana/transfer-tx.ts`
- `server/src/test/env.real-money.test.ts`
- `server/src/test/env.test.ts`
- `server/src/test/harness.ts`
- `server/src/test/round-payout.test.ts`
- Deleted `server/src/auth/privy.ts`
- Deleted `server/src/auth/privy.test.ts`
- Deleted `server/src/auth/privy-wallet.ts`
- Deleted `server/src/auth/privy-wallet.test.ts`
- Deleted `server/src/scripts/phase0-staging.ts`
- Deleted `server/src/scripts/create-treasury.ts`
- Deleted `server/src/solana/withdraw-signer.ts`
- Deleted `server/src/solana/withdraw-signer.test.ts`

## What changed

- Removed the server-side Privy auth, wallet, signer, and script modules listed in the brief.
- Removed `@privy-io/node` from `server/package.json`.
- Refreshed workspace lockfile state with `cd server && npm install`, which updated the repo root `package-lock.json` because this repo uses npm workspaces. `server/package-lock.json` was already clean and remained unchanged.
- Removed Privy env fields and Privy-specific validation from `server/src/env.ts`, and dropped the now-unused `TREASURY_WALLET_ID` env field.
- Replaced the withdraw signer dependency on `server/src/solana/withdraw-signer.ts` with a local `WithdrawSigner` interface exported from `server/src/services/withdraw-worker.ts`.
- Renamed runtime signer result fields from `privyTxId` to `providerTxId` in TypeScript interfaces and tests while continuing to persist to the historical `withdrawals.privy_tx_id` column.
- Updated payout-related wiring in `server/src/index.ts`, `server/src/http/routes.ts`, and the test harness to use the local signer interface instead of the deleted Privy signer module.
- Renamed the round close response field from `payoutPrivyTxId` to `payoutProviderTxId`.
- Removed the last required `@privy` source match from server comments so the mandated scans pass.

## Scan results

- `rg -n "@privy|PrivyClient|makePrivy|privyAuth|PRIVY_" server/src server/package.json`
  - Result: no matches
- `rg -n "@privy" server/package-lock.json server/package.json`
  - Result: no matches

## Tests run, with pass/fail output summary

- Targeted red run:
  - `cd server && npm test -- src/services/withdraw-worker.test.ts src/test/env.test.ts src/test/round-payout.test.ts`
  - Result: failed as expected with `expected null to be 'ptx'`
- Targeted green run:
  - `cd server && npm test -- src/services/withdraw-worker.test.ts src/test/env.test.ts src/test/env.real-money.test.ts src/test/round-payout.test.ts`
  - Result: 4 passed, 16 passed tests
- Full verification test run:
  - `cd server && npm test`
  - Result: 37 passed test files, 2 skipped test files, 200 passed tests, 2 skipped tests

## Build result

- `cd server && npm run build`
- Result: pass (`tsc --noEmit`)

## Self-review

- Required server Privy modules and scripts from the brief were removed.
- Server env parsing no longer accepts or validates Privy-specific fields.
- Withdraw and payout paths still compile, and the payout path now depends only on the local `WithdrawSigner` interface.
- Historical persisted DB column names that contain `privy_` were preserved.
- Required source and lockfile scans are clean.
- Full server test suite and build both passed after the change.

## Any concerns

- The repo is an npm workspace, so the dependency refresh landed in the root `package-lock.json` instead of `server/package-lock.json`.
- Some non-blocking historical `privy` strings still exist in fixture IDs, comments, and database column names outside the required scan patterns. The persisted column names were intentionally kept per the brief.
