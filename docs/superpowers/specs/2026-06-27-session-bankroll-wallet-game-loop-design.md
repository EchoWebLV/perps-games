# Session Bankroll Wallet Game Loop - Design

**Date:** 2026-06-27
**Status:** Approved direction, awaiting user review
**Goal:** Replace fake balances and confusing payment prompts with a wallet-funded session bankroll: connect wallet, fund session, play instantly, cash out to wallet.

## Problem

The current local setup can show fake funded balances through `SIGNUP_FAUCET`, and the wallet UI still carries older "add to play balance" language. That makes the product feel untrustworthy because the player cannot tell whether they are seeing real wallet USDC, an in-game ledger balance, or dev money.

The user's desired product is a real-money loop:

1. Player connects a wallet.
2. Player risks real USDC to play.
3. Losses go to the vault or house.
4. Wins are payable back to the player's wallet.

Putting a wallet transfer on every single race is not the best implementation. It adds wallet popups, chain latency, failed-payment edge cases, and possible "free roll" problems where a player sees a result before the stake is final. The best production pattern is the same pattern used by real-money gaming products: a player account balance funded from wallet deposits, with instant wagers inside the app and explicit withdrawals back to the wallet.

## Decision

Use a **session bankroll** model.

The product loop becomes:

```text
Connect wallet -> Fund session -> Play $1 races instantly -> Cash out to wallet
```

The app must not seed fake player funds in normal wallet mode. A player with no funded session balance sees `$0.00`, not `$100.00`.

## Core UX

### First visit

The primary action is **Connect Wallet**. The game can show the car, chart, and controls, but real play is locked until a wallet is connected.

### Connected but unfunded

The primary action becomes **Fund Session**. The funding panel offers fixed amounts such as `$5`, `$10`, and `$25`, plus the current wallet USDC balance. The default should be `$5` for a low-friction MVP, with `$1` as the default race stake.

Copy should be direct:

```text
$1 per race. Unplayed funds stay withdrawable.
```

### Funded

The primary action is **Play $1**. Pressing it opens a round immediately by debiting the session bankroll in the server ledger. No wallet prompt should appear on the hot path.

### Win or lose

Loss:

```text
Player session bankroll - stake
House bankroll + stake
Vault USDC unchanged
```

Win:

```text
Player session bankroll + payout
House bankroll - payout
Vault USDC unchanged
```

The player can then keep playing or press **Cash Out** to withdraw session bankroll to the connected wallet.

## Money Model

There are three balances the product must distinguish:

1. **Wallet USDC:** On-chain USDC in the connected wallet.
2. **Session bankroll:** Player-owned `cash` in the server ledger, backed by vault USDC.
3. **House bankroll:** House-owned `cash` in the server ledger, also backed by vault USDC.

The HUD should show the session bankroll as the playable balance. The wallet panel can show both wallet USDC and session bankroll, clearly labelled.

The vault is custody. The ledger is ownership. Rounds move ownership between the player and the house without moving USDC on-chain.

## Reuse Existing Architecture

The current codebase already has most of the right primitives:

- `server/src/services/ledger.ts` supports asset-specific `cash`.
- `server/src/services/rounds.ts` already moves stake and payout between player and house ledger accounts.
- `server/src/services/deposits.ts` credits confirmed user-wallet-to-vault USDC transfers.
- `server/src/http/routes.ts` exposes deposit, wallet balance, round, and withdraw routes.
- `redline3d/src/core/play-funding.ts` already models wallet-to-session funding, though the user-facing copy needs to change.
- `redline3d/src/ui/wallet.ts` already has a wallet overlay that can become the Fund Session / Cash Out surface.

The design should refine and clarify this architecture, not introduce a separate per-race payment rail.

## Server Behavior

### Authentication and wallet binding

Wallet connection must bind a Solana wallet to the session account before real-money play is available. If a bound wallet already belongs to another account, the server should recover that wallet's account session instead of creating a duplicate account.

### Funding

Funding uses the existing deposit rail:

1. Client requests a funding transaction for an exact amount.
2. Server builds a USDC transfer from the bound wallet to the treasury vault.
3. Client signs and submits the transaction.
4. Deposit confirmer observes the finalized transfer and credits `cash` to the player's session bankroll.
5. Client polls `/v1/me` or a dedicated balance endpoint until the session bankroll reflects the credit.

For MVP, funding can wait for the existing confirmation path. Funding is outside the race hot path, so a short wait is acceptable.

### Play

`POST /v1/round/open` remains the hot path. It must:

1. Require authenticated user.
2. Require `stakeAsset = "cash"` in real-money mode.
3. Debit the player session bankroll.
4. Credit the house bankroll with the stake.
5. Open the round.

If the player cannot afford the stake, return `402 insufficient_balance`. The client should open the funding panel, not attempt an automatic wallet charge.

### Settlement

`POST /v1/round/close` remains authoritative. It must:

1. Settle from server-stamped price data.
2. Credit player session bankroll with payout when `payout > 0`.
3. Debit house bankroll with the same payout.
4. Return the updated session bankroll.

Auto-pushing every win on-chain is not part of this flow. It creates extra transaction latency and complicates settlement. Cash out is explicit.

### Withdraw

Cash out uses the withdrawal rail:

1. Player presses **Cash Out**.
2. Server reserves the withdrawal from session bankroll.
3. Server signs and sends treasury-to-wallet USDC transfer when approved by the configured withdrawal flow.
4. UI shows pending, sent, confirmed, or needs review.

For local/dev mode, the app can show withdrawal disabled unless real-money treasury config is present.

## Client Behavior

### HUD

The top-left balance must be labelled as playable session bankroll. It must never imply wallet funds are playable before they are deposited.

Recommended label:

```text
SESSION
$0.00
```

### Primary button states

The GO button should become stateful:

| State | Button | Action |
|---|---|---|
| No wallet | Connect Wallet | Opens wallet connect |
| Wallet connected, session balance below stake | Fund Session | Opens funding panel |
| Funded, not live | Play $1 | Opens round instantly |
| Live | Cash Out / Bail | Settles round |

### Wallet panel

The wallet panel should be renamed from a generic wallet page to a money panel:

```text
Wallet
Wallet USDC: $X.XX
Session bankroll: $Y.YY
Fund Session
Cash Out
```

Remove copy that says "Add to play balance" unless it is replaced with the clearer "Fund Session".

### Dev mode

Dev mode may keep soft coins for non-money testing, but it must not masquerade as real wallet USDC. If a faucet exists, it should be hidden behind a dev-only label such as:

```text
DEV COINS
```

The normal wallet flow should start at `$0.00`.

## Error Handling

- Wallet connect rejected: keep the player on Connect Wallet and show "Connect canceled".
- Wallet has insufficient USDC to fund: show "Not enough USDC in wallet".
- Funding transaction rejected: leave session bankroll unchanged.
- Funding transaction submitted but not credited yet: show "Funding pending" and keep polling.
- Funding confirms: update session bankroll and enable Play.
- Round open returns `insufficient_balance`: open Fund Session.
- Withdrawal unavailable in local/dev mode: show "Cash out unavailable in this environment".
- Withdrawal pending: keep the amount out of playable balance and show a pending status.

## Acceptance Criteria

1. A fresh wallet-mode session shows `$0.00`, not a faucet balance.
2. The primary action says **Connect Wallet** before a wallet is connected.
3. After wallet connection with no session bankroll, the primary action says **Fund Session**.
4. Funding credits the session bankroll only after a confirmed vault deposit.
5. Pressing **Play $1** with enough session bankroll starts a round without opening a wallet signature prompt.
6. A losing round leaves the stake in the house bankroll.
7. A winning round credits the player's session bankroll from the house bankroll.
8. Cash out is explicit and sends session bankroll to the connected wallet through the withdrawal rail.
9. Soft dev coins are clearly labelled as dev-only when used.
10. The UI never combines wallet USDC and session bankroll into one ambiguous total.

## Testing Strategy

### Server tests

- Fresh `/v1/me` in real-money mode returns `cash` balance `0`.
- Funding deposit credits `cash` once and only once.
- Round open debits player `cash` and credits house `cash`.
- Losing settlement conserves player plus house `cash`.
- Winning settlement credits player `cash` and debits house `cash`.
- Insufficient bankroll returns `402 insufficient_balance`.
- Withdrawal reserve debits player `cash` and creates a withdrawal row.

### Client tests

- Primary action state machine: no wallet, unfunded wallet, funded wallet, live round.
- Short balance opens Fund Session and does not call `roundSync.open`.
- Funded balance calls `roundSync.open` and does not call wallet signing.
- Wallet panel displays wallet USDC and session bankroll separately.
- Faucet/dev balance never appears as wallet USDC.

### Browser verification

- Fresh app at `localhost:4000` shows `$0.00` in wallet mode.
- No reconnect banner.
- Button flow progresses from Connect Wallet to Fund Session to Play.
- In dev/test mode, injected funding enables Play without a wallet prompt on each round.

## Out Of Scope

- Per-race wallet signature.
- Fully on-chain round settlement.
- Auto-pushing every win immediately to wallet.
- Casino compliance automation beyond basic limits and records.
- Production mainnet launch.
- New smart contracts.

## Implementation Direction

The implementation plan should focus on small vertical slices:

1. Rename and separate balances in the client model.
2. Replace GO button gating with the Connect Wallet / Fund Session / Play state machine.
3. Ensure server real-money mode starts at zero and requires `cash` bankroll for play.
4. Tighten tests around house/player ledger conservation.
5. Keep withdrawal explicit and visibly pending.

