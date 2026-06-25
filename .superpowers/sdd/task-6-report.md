# Task 6 Report: Add Client Session Auth

## Summary

Implemented client session auth for `redline3d` by introducing anonymous session bootstrap via `POST /v1/session`, narrowing the client auth contract to identity and headers, updating API types for wallet binding and deposit routes, and removing the Privy client auth path from `main.ts`.

Also applied the required compile-safe wallet transition for Task 6: no client wallet is connected yet, wallet address is empty, wallet balance remains `null`, and Add to Play now surfaces a wallet-not-connected state without calling auth signing methods.

## Changed Files

- `redline3d/src/core/auth.ts`
- `redline3d/src/core/auth-session.ts`
- `redline3d/src/core/auth-session.test.ts`
- `redline3d/src/core/auth-dev.ts`
- `redline3d/src/core/auth-privy.ts`
- `redline3d/src/core/api.ts`
- `redline3d/src/core/api.test.ts`
- `redline3d/src/core/round-sync.test.ts`
- `redline3d/src/main.ts`

## Implementation Notes

### Auth contract

- Reduced `AuthProvider` to:
  - `ready()`
  - `userId()`
  - `authHeaders()`
  - optional `logout()`

### Session auth

- Added `createSessionAuth()` in `redline3d/src/core/auth-session.ts`.
- Behavior:
  - Reuses stored token and user id when present.
  - Otherwise creates a new anonymous session with `POST /v1/session`.
  - Persists `redline.session:token` and `redline.session:user`.
  - Returns `authorization: Bearer <token>` from `authHeaders()`.
  - Clears persisted session state on `logout()`.

### Dev auth

- Simplified `createDevAuth()` to the new auth surface.

### API

- Added:
  - `bindWalletChallenge(wallet)`
  - `bindWallet(input)`
  - `depositSend(input)`
- Updated `depositBuild()` response type to include:
  - `txBase64`
  - `depositIntent`
  - `expiresAt`
- Updated wallet-related comments from Privy-specific wording to connected-wallet wording.

### Main client transition

- Removed the Privy auth import and selection path from `main.ts`.
- Default auth is now `createSessionAuth()`, with `createDevAuth()` only under `VITE_AUTH=dev`.
- `triggerSignIn()` now calls `initSession()`.
- `doLogout()` now only clears session state through `auth.logout?.()` and reloads.
- Wallet transition for Task 6:
  - connected wallet address is hardcoded empty
  - wallet balance refresh always resolves to `null`
  - Add to Play sets a clear HUD message and throws `wallet_not_connected`
  - no auth signing methods remain on `AuthProvider`

## TDD Evidence

1. Added `redline3d/src/core/auth-session.test.ts` before implementation.
2. Extended `redline3d/src/core/api.test.ts` before implementation for wallet bind and deposit route shapes.
3. Verified red state:
   - `auth-session.test.ts` failed because `./auth-session` did not exist
   - `api.test.ts` failed because `bindWalletChallenge` was not implemented
4. Implemented the minimum production changes to satisfy those tests.
5. Re-ran the required tests and build until green.

## Verification

### Required tests

Command:

```bash
cd redline3d && npx vitest run src/core/auth-session.test.ts src/core/auth.test.ts src/core/api.test.ts
```

Result:

- `Test Files  3 passed`
- `Tests  11 passed`

### Build

Command:

```bash
cd redline3d && npm run build
```

Result:

- `tsc --noEmit` passed
- `vite build` passed

Build note:

- Vite emitted the existing large-chunk warning for `dist/assets/index-*.js` over 500 kB after minification.

## Self-Review

- Confirmed `AuthProvider` no longer exposes wallet or signing methods.
- Confirmed `main.ts` no longer imports or selects Privy auth.
- Confirmed Add to Play does not call any signing path and surfaces a wallet-not-connected state.
- Confirmed API types match Task 6 server shapes for wallet binding and deposit build/send.
- Confirmed test doubles compile with the stricter `Api` interface.
- Kept wallet adapter and funding wiring out of scope for Task 8.

## Concerns

- `redline3d/src/core/auth-privy.ts` was narrowed to satisfy the new `AuthProvider` contract for build correctness, but it is now effectively dormant because `main.ts` no longer selects Privy auth in Task 6. If that module is reused later, Task 8 should reintroduce wallet-specific behavior through the planned wallet port rather than the old auth interface.
