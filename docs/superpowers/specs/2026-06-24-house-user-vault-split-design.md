# House / user / vault split — design

**Date:** 2026-06-24
**Branch:** real-money-rails
**Status:** approved (whiteboarded + confirmed)

**Goal:** Make the real-money game a properly house-banked game — each player wagers their **own** deposited balance, **wins are paid from a house bankroll, losses grow it** — without commingling player deposits *as* the bankroll. Pure ledger bookkeeping; no engine, payout, leverage, or feed changes.

## The problem this fixes

Today all real USDC sits in one Privy treasury vault, and a player's deposit is credited to them as a `cash` balance. But there is **no house account**: on a losing round the stake just vanishes from the player's balance (credited to nobody), and on a win the payout appears from nowhere. It nets to the right house P&L but is invisible, un-auditable, and — critically — **nothing funds the wins**. With only a player's own $11 in the vault and no separate house capital, "playing your $11 against the vault" is circular.

## The model (two layers)

1. **On-chain — custody.** One Privy treasury vault physically holds **all** USDC: the house bankroll *and* every player's deposit, commingled. This is unavoidable for an off-chain-ledger design — per-round on-chain settlement would be a Solana tx per bet. The vault only moves on **deposit** (USDC in), **withdraw** (USDC out), and **house funding** (operator → vault).

2. **Off-chain ledger — ownership.** The ledger is the source of truth for *who owns* the vault. It splits the pile into each **player account** (their money) and the **house bankroll** (the house's money). A round moves money **between** player and house **in the ledger only**; the vault sits still.

### Invariants
- **Conservation:** `vault USDC == Σ(all player cash) + house bankroll`. Every deposit adds to both sides; every withdraw subtracts from both; every round just shuffles player↔house, so the total never changes.
- **Solvency (the one that matters):** `vault USDC ≥ Σ(player cash)` ⇔ `house bankroll ≥ 0`. A negative bankroll means the operator owes more than the vault holds — under-capitalized, fund it.

## Components / changes

### 1. House account — `system:house`
A reserved `users` row (externalId `system:house`), resolved to a `houseUserId` at boot. The **bankroll is its `cash` balance**. It never authenticates (no `dev:`/`privy:` auth prefix) and never opens rounds. Reuses the existing users + ledger machinery — no new table.

### 2. `ledger.postOn(tx, userId, asset, delta, reason, ref)`
A tx-scoped raw append mirroring the existing public `post`: signed `delta` (may be negative), idempotent on `(asset, reason, ref)`, **no balance check, no advisory lock**. Used for the house leg so a player's win is never blocked by a short bankroll. Safe without a lock because it is a pure append (no read-modify-write); the house balance is a `SUM` over independent rows.

### 3. Conserved round settlement (`rounds.ts`)
`makeRounds` gains a required `houseUserId: string`. The house leg uses its **own reasons** because `ledger_idem_idx` is unique on `(asset, reason, ref)` *without* `userId` — reusing `round_stake`/`round_payout` would collide with the player leg and be silently swallowed.

- **Open** (inside the existing tx, after the round row is inserted):
  - player: `debitOn(tx, userId, stakeAsset, stake, "round_stake", roundId)` — unchanged, balance-checked.
  - house: `creditOn(tx, houseUserId, stakeAsset, stake, "round_stake_house", roundId)` — stake escrows into the house.
- **Close** (inside the existing settle tx, when `payoutCoins > 0`):
  - player: `creditOn(tx, userId, stakeAsset, payout, "round_payout", roundId)` — unchanged.
  - house: `postOn(tx, houseUserId, stakeAsset, -payout, "round_payout_house", roundId)` — house pays the win; **allowed to go negative**.
- Net: player `payout − stake`, house `stake − payout`, sum zero.
- Idempotency: `roundId` is fresh per open; close short-circuits on `settled` (no re-pay). House legs are idempotent on their `(asset, reason, roundId)` too.
- Applies to whatever `stakeAsset` the instance uses (coin or cash). The coin-mode house balance is harmless (coin is faucet-minted, not solvency-relevant).

### 4. Solvency redefinition (`reconcile.ts`, `vault-status.ts`)
`makeReconcile` gains the `houseUserId`. `solvency()` returns:
- `liabilitiesCents` = Σ `cash` over users **except** `system:house`.
- `bankrollCents` = `system:house` cash (may be negative).
- `onChainCents` = vault USDC (floored to cents).
- `solvent` = `onChainCents ≥ liabilitiesCents`.
- `conserved` = `onChainCents == liabilitiesCents + bankrollCents` (within dust).

`vault-status.ts` prints liabilities, bankroll (flag red if negative), on-chain, solvent, conserved.

### 5. Bootstrap — re-label the existing $11
The $11 currently credited to the tester account is moved (ledger-only) to `system:house`: debit tester `cash` $11, credit `system:house` `cash` $11 (reason `house_seed`, distinct ref). Vault and total liabilities-vs-vault unchanged; solvency unchanged. Result: house bankroll $11, tester $0. The operator then deposits fresh into their own player account and plays. A small script (`seed-house.ts`) performs the move; it must point at the **same** account the tester actually plays as (the wallet-bound one), verified at run time.

## Data flow (after the change)

| Event | Player cash | House cash | Vault USDC |
|---|---|---|---|
| Deposit $5 | +5 | — | +5 |
| Round open, $1 stake | −1 | +1 | — |
| Round win, $2 payout | +2 | −2 | — |
| Round lose, $0 payout | — | (keeps the +1) | — |
| Withdraw $4 | −4 | — | −4 (chain-capped) |
| House funding $X | — | +X | +X |

## Out of scope (explicitly not building)
- No stake caps, per-tick throttles, max-stake schedules, or hedge — under-capitalization is surfaced (negative bankroll), not prevented. The operator manages risk by funding the bankroll.
- No engine / payout / leverage / feed changes.
- On-chain **house top-up** path (operator → vault credited to house via the confirmer) is a later follow-up; for now the bankroll is seeded by the $11 re-label and can be topped up by a manual script.

## Testing
- `ledger.postOn`: posts signed deltas in a tx; idempotent on `(asset, reason, ref)`; allows the balance to go negative.
- `rounds` (cash): a win debits the house and credits the player by the same payout (conserved); a loss leaves the escrowed stake in the house; player + house cash deltas sum to zero across a round.
- `rounds`: a winning payout settles even when the house bankroll is below the payout (house goes negative, player still paid).
- `reconcile.solvency`: excludes `system:house` from liabilities; reports bankroll; `solvent` flips when bankroll goes negative; `conserved` holds across deposits and rounds.
