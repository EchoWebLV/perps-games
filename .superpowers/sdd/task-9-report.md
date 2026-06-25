Status

Completed.

Changed files

- `redline3d/package.json`
- `redline3d/package-lock.json`
- `redline3d/src/core/appsigner.test.ts`
- `redline3d/src/core/appsigner.ts`
- `redline3d/src/core/auth-privy.ts` (deleted)
- `redline3d/src/core/identity.ts`
- `redline3d/src/core/privy-island.ts` (deleted)
- `redline3d/src/core/wallet-balance-model.ts`
- `redline3d/src/ui/controls.ts`

What changed

- Deleted the unused client Privy modules `auth-privy.ts` and `privy-island.ts`.
- Removed `@privy-io/react-auth`, `react`, `react-dom`, `@types/react`, and `@types/react-dom` from `redline3d/package.json`.
- Refreshed `redline3d/package-lock.json` with `npm install --legacy-peer-deps` after plain `npm install` hit an existing peer-resolution conflict inside the stale Privy dependency tree.
- Removed the `#privy-root` keyboard guard exception from `redline3d/src/ui/controls.ts` and updated the related comment to generic input-field wording.
- Renamed the stale Privy signer surface in `redline3d/src/core/appsigner.ts` to `external-wallet` / `createExternalWalletSigner`, and added test coverage for that public shape in `redline3d/src/core/appsigner.test.ts`.
- Updated stale client comments in `redline3d/src/core/identity.ts` and `redline3d/src/core/wallet-balance-model.ts` so the Task 9 client scan is clean.

Scan results

- `rg -n "Privy|privy|@privy|privy-root|VITE_PRIVY" redline3d/src redline3d/package.json`
  - Result: no matches
- `rg -n "@privy" redline3d/package-lock.json redline3d/package.json`
  - Result: no matches

Tests run, with pass/fail output summary

- `cd redline3d && npm test`
  - Pass
  - Summary: `Test Files 32 passed (32)`, `Tests 143 passed (143)`
- Targeted red/green check during implementation:
  - `npm test -- src/core/appsigner.test.ts`
  - Red: failed because `createExternalWalletSigner` did not exist yet
  - Green: passed after implementation with `2 passed (2)`

Build result, including whether any `privy-island` chunk appears

- `cd redline3d && npm run build`
  - Pass
  - Build completed successfully with an existing Vite chunk-size warning for `dist/assets/index-Bh4X2ACW.js` at `738.98 kB`.
  - No `privy-island` chunk appears in the build output.

Self-review

- Confirmed the required client/source scans are clean.
- Confirmed the lockfile no longer contains `@privy`.
- Kept changes scoped to client cleanup only and did not touch server Privy code.
- Left external wallet adapter packages intact.

Any concerns

- `npm install` without flags failed on an existing peer-dependency resolution conflict inside the stale Privy/React tree. `npm install --legacy-peer-deps` completed cleanly and produced the expected lockfile cleanup.
- The build still emits the existing Vite chunk-size warning for the main bundle.
