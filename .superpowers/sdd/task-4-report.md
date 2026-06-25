# Task 4 Report: Add Signed Wallet Binding On The Server

## What I implemented

- Added `server/src/auth/wallet-binding.ts` with:
  - HMAC-signed wallet bind challenges
  - challenge message generation including wallet, session user id, nonce, and expiry
  - server-side verification of Solana Ed25519 signatures
  - expiry enforcement and malformed challenge rejection
- Added `POST /v1/wallet/bind-challenge` and `POST /v1/wallet/bind` in `server/src/http/routes.ts`.
- Extended `RouteDeps` with `walletBinding`.
- Wired `walletBinding` into production boot in `server/src/index.ts`.
- Wired `walletBinding` into the test harness default setup in `server/src/test/harness.ts`.
- Added a wallet uniqueness guard in `server/src/services/users.ts` so one wallet cannot be bound to multiple users.
- Preserved existing set-once wallet semantics for a user while returning `409 wallet_already_bound` when another user already owns the wallet.
- Added route-level coverage for successful bind flow in `server/src/test/deposit-address.test.ts`.

## What I tested and test results

Focused tests required by the brief:

- `cd server && npx vitest run src/auth/wallet-binding.test.ts src/test/deposit-address.test.ts`
  - Result: passed
  - Files: 2 passed
  - Tests: 15 passed

Build required by the brief:

- `cd server && npm run build`
  - Result: passed

Additional focused TDD step:

- `cd server && npx vitest run src/auth/wallet-binding.test.ts`
  - Red: failed before implementation because `./wallet-binding.js` did not exist
  - Green: passed after implementation with 3 tests passing

## TDD Evidence

### RED

Command:

```bash
cd server && npx vitest run src/auth/wallet-binding.test.ts
```

Summary:

- Suite failed before implementation.
- Failure was the expected missing module error for `./wallet-binding.js`.
- This confirmed the new test was exercising code that did not exist yet.

### GREEN

Command:

```bash
cd server && npx vitest run src/auth/wallet-binding.test.ts
```

Summary:

- Suite passed after implementing `wallet-binding.ts`.
- 1 file passed, 3 tests passed.

Validation after integration:

```bash
cd server && npx vitest run src/auth/wallet-binding.test.ts src/test/deposit-address.test.ts
cd server && npm run build
```

Summary:

- Focused wallet-binding plus deposit-address suite passed.
- TypeScript build passed.

## Files changed

- `server/src/auth/wallet-binding.ts`
- `server/src/auth/wallet-binding.test.ts`
- `server/src/http/routes.ts`
- `server/src/services/users.ts`
- `server/src/index.ts`
- `server/src/test/harness.ts`
- `server/src/test/deposit-address.test.ts`

## Self-review findings

- The implementation matches the file list and flow in the task brief.
- The new bind routes require authenticated user context and reject mismatched challenge ownership.
- The uniqueness guard is enforced in the service layer, which keeps route logic thin and protects other callers.
- I did not remove any existing Privy server packages or client Privy code.
- Scope stayed limited to Task 4 surfaces plus the explicit production/test wiring points from the brief.

## Issues or concerns

- No blocking issues found.
- The route-level suite currently covers the success path. The service-level uniqueness/rebind behavior continues to rely on existing `users` tests plus the new route wiring.
