# Money Rails 3 — Withdraw Send-Leg (self-custody treasury signer)

**Date:** 2026-06-25
**Branch:** `real-money-rails`
**Status:** Design approved; implementation pending
**Scope:** Cash out in-game `cash` winnings to a user's Solana wallet, signed by a treasury keypair the server controls. No Privy.

## Problem

The withdrawal reservation path is built and live (`POST /v1/withdraw` → reserve, debit, `awaiting_approval`), but the **send leg is unwired**: `withdrawProcessor` and `payoutSigner` are both `null` in [index.ts](../../../server/src/index.ts) (lines 40, 140–141), and no treasury signer exists. So `cash` can be earned and reserved for withdrawal, but nothing ever moves USDC out of the treasury ATA. Privy used to sign payouts; it was removed, leaving this hole.

This spec fills the hole with a **self-custody local keypair** (Option A), built and proven on **devnet first**.

## Decisions (locked)

- **Self-custody keypair**, reusing the existing local-keypair signing pattern from [fee-payer-signer.ts](../../../server/src/solana/fee-payer-signer.ts). Not Privy.
- **Explicit withdrawals only.** `payoutSigner` stays `null` — round wins are **not** auto-pushed on-chain ([routes.ts:265](../../../server/src/http/routes.ts) round-payout send stays gated off). Wins accumulate in the player's in-game `cash` balance; USDC leaves the treasury only when the user explicitly withdraws and an admin approves. Auto-push remains a future one-line opt-in.
- **Devnet-first.** All development and testing uses a throwaway treasury keypair + devnet USDC + throwaway destination wallet. The real $21.45 mainnet treasury is never touched during development.
- **Treasury pays its own gas.** For the withdraw direction the treasury authority is also the fee payer (one keypair, one signer slot). This does not conflict with the deposit fee-payer rule at [index.ts:69–71](../../../server/src/index.ts) — that rule forbids a *separate* deposit fee payer from being the treasury authority; the withdraw outflow legitimately is the treasury.

## Architecture

Three new pieces plus wiring. Nothing changes when `TREASURY_SECRET` is unset — current behavior is fully preserved.

### 1. `solana/treasury-signer.ts` (new) — implements the `WithdrawSigner` port

The port already exists in [withdraw-worker.ts](../../../server/src/services/withdraw-worker.ts):

```ts
interface WithdrawSigner {
  signAndSend(input: { destWallet: string; amountCents: number; idempotencyKey: string }):
    Promise<{ txSig: string; providerTxId: string | null }>;
}
```

`signAndSend` flow:

1. Derive the destination USDC ATA: `findAssociatedTokenPda({ owner: destWallet, mint: usdcMint, tokenProgram: LEGACY_TOKEN_PROGRAM })` — same helper [deposit-tx.ts:46](../../../server/src/services/deposit-tx.ts) uses.
2. Fetch a fresh blockhash via the existing `makeRpcBlockhash(rpcUrl)` ([deposit-tx.ts:67](../../../server/src/services/deposit-tx.ts)).
3. Build the unsigned message with the existing [transfer-tx.ts](../../../server/src/solana/transfer-tx.ts) `buildTransferCheckedMessage`:
   - `source` = treasury USDC ATA, `authority` = treasury owner pubkey, `destination` = dest ATA,
   - `feePayer` = treasury owner pubkey (same key signs both slots),
   - `amount` = `centsToBaseUnits(amountCents)`, `decimals` = 6.
4. Sign with the treasury keypair via `partiallySignTransaction([keyPair], compileTransaction(message))` — exactly the [fee-payer-signer.ts](../../../server/src/solana/fee-payer-signer.ts) primitive. One key covers the authority + feePayer slots.
5. `assertIsFullySignedTransaction`, then broadcast via `rpc.sendTransaction(getBase64EncodedWireTransaction(signed))`.
6. Return `{ txSig, providerTxId: null }`.

Construction mirrors `makeFeePayerSigner`: parse the secret (`parseFeePayerSecret` — JSON array or base64), `createKeyPairSignerFromBytes`, and **expose `.address` so boot can assert it equals `TREASURY_OWNER_PUBKEY`**.

> **Idempotency note.** A local signer has no provider-side idempotency key (Privy had one). The deterministic `withdraw:<id>` key (`withdrawIdempotencyKey`) is still threaded through, but exactly-once relies on the DB state machine: the `awaiting_approval → signing` claim in `approveAndSend` is a single-row conditional update (only one caller wins), and a row already in `sent` is never re-sent. This is the dedup guarantee.

### 2. `solana/chain-status.ts` (new) — `ReadChainStatus` adapter

`ReadChainStatus = (txSig) => Promise<"finalized" | "failed" | "unknown">` ([withdraw-worker.ts:40](../../../server/src/services/withdraw-worker.ts)). Implemented with `rpc.getSignatureStatuses([txSig])`:

- `confirmationStatus === "finalized" && err === null` → `"finalized"`
- `err !== null` (landed but failed) → `"failed"`
- otherwise (not yet finalized, or status `null`) → `"unknown"`

`getSignatureStatuses` is not used anywhere in the codebase yet, so this adapter is genuinely new.

### 3. Withdraw confirmer poll loop (in `index.ts`)

`makeWithdrawConfirmer(db, ledger, readStatus)` already exists but exposes only a **per-id** `confirm(id)` — unlike `makeDepositConfirmer`, it has no `.start()/.stop()`. Add a thin poller (gated on the existing `RUN_CONFIRMER` flag, alongside the deposit confirmer at [index.ts:54–56](../../../server/src/index.ts)) that:

- selects `withdrawals` rows in status `sent`,
- calls `confirmer.confirm(id)` for each, on a `WITHDRAW_POLL_MS` interval,
- returns `{ start(); stop() }` so shutdown is clean.

`confirm` is the only thing that auto-transitions a `sent` row: `finalized → confirmed`, `failed → reversed` (re-credits `cash` via `ledger.creditOn(..., "withdraw_reverse", ...)` in a tx), `unknown → needs_review` (never auto-reversed).

### 4. `env.ts` (modify)

Add `TREASURY_SECRET` (optional string; parsed like `FEE_PAYER_SECRET`). Add `WITHDRAW_POLL_MS` (default e.g. 4000). All `WITHDRAW_*` caps already exist with safe defaults: min $1, max **$5/tx**, **$20/user/day**, $200/global/day, 24h hold.

### 5. `index.ts` (modify) — wiring

Inside the `REAL_MONEY_ENABLED` block, when `TREASURY_SECRET` is set:

1. Build the treasury signer; **assert `signer.address === TREASURY_OWNER_PUBKEY` or throw** (refuse to boot on mismatch — same guard style as the fee-payer check).
2. `withdrawProcessor = makeWithdrawProcessor(db, treasurySigner)` → pass to `buildServer` instead of `null`. This flips the admin-approve endpoint ([routes.ts:213](../../../server/src/http/routes.ts)) from 404 to live.
3. Build `ReadChainStatus`, construct `makeWithdrawConfirmer`, start the poller (when `RUN_CONFIRMER`).
4. Leave `payoutSigner = null` (explicit-withdrawals-only decision).

When `TREASURY_SECRET` is unset: everything stays `null`, the approve endpoint keeps 404ing, no poller starts — identical to today.

## Data flow (end to end)

```
player wins  → cash credited in-game (no on-chain tx; payoutSigner null)
POST /v1/withdraw → reserve: caps + hold + solvency check, atomic cash debit, status=awaiting_approval
admin approve     → approveAndSend: awaiting_approval → signing (one-shot claim)
                     → treasurySigner.signAndSend: build transferChecked, sign w/ treasury key, broadcast
                     → status=sent, txSig recorded
confirmer poll    → getSignatureStatuses(txSig):
                       finalized → confirmed
                       failed    → reversed  (re-credit cash)
                       unknown   → needs_review (manual; never auto-reverse)
```

## Error handling

- **Send throws** (RPC down, blockhash expired): `approveAndSend` propagates; the row stays in `signing`. Operationally re-approvable only after manual review — it does **not** auto-retry into a double-send. (A `signing`-stuck sweep is out of scope; flagged below.)
- **`failed` on chain** (landed, tx errored): confirmer reverses and re-credits `cash`. Funds never left.
- **`unknown`**: `needs_review`, never auto-reversed — avoids the double-spend risk of reversing a tx that later finalizes.
- **Dest ATA missing**: `transferChecked` fails → `failed` → reversed. Known limitation: the destination wallet must already have a USDC ATA (it will, since it deposited from that wallet). Idempotent ATA-create is a future option, not built now.

## Testing

**Unit (devnet/offline):**
- `treasury-signer`: known throwaway keypair → asserts the compiled message has treasury ATA as source, correct dest ATA, `amount = centsToBaseUnits`, and a valid treasury-slot signature; `.address` matches the keypair.
- `chain-status`: stubbed `getSignatureStatuses` → maps finalized/err/null to the three statuses.

**Devnet end-to-end (the real proof):**
1. Generate a throwaway treasury keypair; create its devnet USDC ATA; fund it with devnet USDC.
2. Throwaway destination wallet with an existing devnet USDC ATA.
3. Run the full path: reserve → approve → sign → send → confirm.
4. Assert: devnet USDC actually moved treasury→dest, withdrawal row reaches `confirmed`, and the `cash` ledger reconciles (debited once, not re-credited).
5. Negative: force a `failed` send → assert `reversed` + `cash` re-credited exactly once.

The mainnet treasury is untouched throughout.

## Out of scope (flagged, not built)

- Four-eyes / real admin auth on the approve endpoint (currently dev-gated). Required before any production exposure.
- Cold-treasury / hot-float split (hot key on the server is bounded only by admin-approval + tiny caps + 24h hold).
- OFAC / sanctions screening.
- Multi-replica worker coordination; `signing`-stuck auto-sweep; idempotent dest-ATA creation.
- Round-win auto-push (`payoutSigner`) — deliberately off.

## Mainnet cutover (user-performed, last)

Not part of the build. When ready: generate the production treasury keypair, move the existing treasury USDC into its ATA, set `TREASURY_SECRET` + `TREASURY_OWNER_PUBKEY` + `TREASURY_USDC_ATA`, restart. **Open dependency:** this migration requires whatever access currently custodies the treasury funds (Privy treasury) — confirm that access exists before the cutover. It does not block devnet development.
