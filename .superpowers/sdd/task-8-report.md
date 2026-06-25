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
