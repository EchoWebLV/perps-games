# Task 8 Report: Wire Wallet Binding And Deposit Funding In The Client

## Status

DONE

## Changed Files

- `redline3d/src/core/wallet-binding.ts`
- `redline3d/src/core/wallet-binding.test.ts`
- `redline3d/src/core/play-funding.ts`
- `redline3d/src/core/play-funding.test.ts`
- `redline3d/src/core/solana-wallet.test.ts`
- `redline3d/src/ui/wallet.ts`
- `redline3d/src/ui/wallet.test.ts`
- `redline3d/src/main.ts`

## What Changed

- Added `connectAndBindWallet()` and local base58 encoding in `wallet-binding.ts` to connect a wallet, fetch the server challenge, sign it, and bind the wallet under session auth.
- Extended `play-funding.ts` so deposit builders can return either a raw base64 transaction or a server deposit object with `depositIntent`, and so the signer path can use either direct wallet broadcast or the server broadcaster fallback.
- Updated wallet UI copy from Privy wording to connected-wallet wording.
- Added connect wallet actions to the wallet screen, including connect buttons in disconnected Buy and Receive states.
- Wired `main.ts` to:
  - lazily load the wallet port only from wallet screen actions,
  - bind the connected wallet through the new challenge flow,
  - read wallet USDC balance from `/v1/wallet/usdc-balance`,
  - keep `GO!` wallet-free,
  - use `depositSend` when the wallet only supports `signTransaction`.

## TDD Evidence

1. Added failing coverage first for:
   - `src/core/wallet-binding.test.ts`
   - deposit object support in `src/core/play-funding.test.ts`
   - wallet SDK import isolation in `src/core/solana-wallet.test.ts`
   - wallet connect/copy UI behavior in `src/ui/wallet.test.ts`
2. Ran the targeted Vitest command and observed the expected red state:
   - missing `wallet-binding.ts`
   - `main.ts` missing wallet-port wiring
   - wallet UI missing connect buttons
3. Implemented the minimum production changes to satisfy those failures.
4. Re-ran the targeted Vitest command to green.

## Verification

### Tests

Command:

```bash
cd redline3d && npx vitest run src/core/wallet-binding.test.ts src/core/solana-wallet.test.ts src/core/play-funding.test.ts src/ui/wallet.test.ts
```

Result:

- 4 test files passed
- 15 tests passed

### Build

Command:

```bash
cd redline3d && npm run build
```

Result:

- Build passed
- Vite emitted the existing chunk-size warning for large bundles, but completed successfully

## Self-Review

- `main.ts` only imports `loadSolanaWalletPort` and `SolanaWalletPort` from the wallet wrapper, not wallet SDK packages directly.
- Wallet connection is lazy and only triggered from wallet screen button flows.
- `GO!` still checks only server balance and open/recover flow. It does not build, sign, or send deposit transactions.
- The Add to Play path now supports both:
  - wallet-native `signAndSendTransaction`
  - `signTransaction` plus server `/v1/deposit/send`
- UI coverage was practical under the repo’s node test environment, so `src/ui/wallet.test.ts` was added instead of skipped.

## Concerns

- No blocking concerns.

## Task 8 Fix Follow-up

### Status

DONE

### Changed Files

- `redline3d/src/core/wallet-binding.ts`
- `redline3d/src/core/wallet-binding.test.ts`
- `redline3d/src/core/wallet-connection.ts`
- `redline3d/src/core/wallet-connection.test.ts`
- `redline3d/src/main.ts`

### What Changed

- Added `hydrateBoundWallet()` so session init can hydrate the server-bound wallet and wallet USDC balance from `api.walletBalance()` without loading wallet SDKs or prompting a wallet connection.
- Added `ensureWalletConnection()` so reconnects validate the actually connected wallet against the stored server-bound wallet and skip rebinding when the addresses already match.
- Added `WalletMismatchError` and fail-closed handling for mismatched reconnects, returning `wallet_mismatch` instead of rebinding a different wallet into the session.
- Added `submitDeposit()` to cover the `signTransaction` plus `api.depositSend()` fallback in a focused helper test instead of relying on `main.ts`.
- Tightened `connectAndBindWallet()` so it rejects when `bindWalletChallenge()` echoes a different wallet than the one that just connected.
- Updated `main.ts` to track `boundWalletAddress` separately from `connectedWalletAddress`, hydrate the bound wallet during session init, refresh wallet balance against the bound wallet, and reuse the new orchestration helper for connect/reconnect flows.

### Tests Run

- `cd redline3d && npx vitest run src/core/wallet-binding.test.ts src/core/solana-wallet.test.ts src/core/play-funding.test.ts src/core/wallet-connection.test.ts src/ui/wallet.test.ts`
  - PASS: 5 test files passed, 23 tests passed

### Build Result

- `cd redline3d && npm run build`
  - PASS: production build completed successfully
  - Note: existing Vite chunk-size warning still appears for large bundles

### Self-Review

- Server-bound wallet hydration stays wallet-SDK-free and prompt-free.
- Reconnect no longer rebinds blindly after reload and will reject a different connected wallet with `wallet_mismatch`.
- The GO flow remains wallet-free.
- Deposit send fallback remains behind the wallet wrapper and now has direct unit coverage.

### Concerns

- No blocking concerns.
