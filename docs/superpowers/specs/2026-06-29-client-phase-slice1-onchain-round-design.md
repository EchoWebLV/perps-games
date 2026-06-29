# Client Phase — Slice 1: Minimal On-Chain Round (design)

**Date:** 2026-06-29
**Branch:** `onchain-er-rebuild`
**Status:** design — pending user review before writing-plans

## Goal

Prove the redline3d browser client can drive the **deployed on-chain `raider` program** end-to-end on devnet: connect a self-custody wallet, fund a play balance, play one real BTC round settled in the MagicBlock Ephemeral Rollup (ER) against the on-chain Pyth Lazer feed, and withdraw — with the HUD reading on-chain truth. This is the first slice of the client phase; it is a **wiring proof**, not the polished product.

## Context

Phases 0–2 (the on-chain program) are complete, deployed, and — as of 2026-06-29 — **adversarially stress-tested green** (four-dimension audit + 9/9 local math tests + live devnet `raider.ts` regression; conservation, solvency, non-custodial, and provable-fairness invariants all proven; no blocking issues). The program is frozen for this slice.

- Program: `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv` (devnet, upgrade authority = the dev funder).
- ER endpoint: `https://devnet.magicblock.app` (ws `wss://devnet.magicblock.app`); validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`.
- L1: `https://api.devnet.solana.com` (pin `BASE_WS=wss://api.devnet.solana.com`).
- PDAs: PlayerBalance `[b"player", owner, mint]`, HouseBalance `[b"house", mint]`, Round `[b"round", owner]`, vault authority `[b"vault", mint]` (owns the USDC vault ATA).
- BTC feed: `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr`.

## Scope (locked)

**In scope:** connect wallet → `buy_in` → one BTC round (`init_round` → `delegate_session` → `open` → player `close` / time `force_close` → `commit_and_undelegate`) → `withdraw`; devnet; web; HUD reads on-chain `PlayerBalance`/`Round`.

**Out of scope (later slices):**
- Session keys / zero-popup signing (Slice 2) — wallet popups per signature are acceptable here.
- Mid-round `flip`/`lever` and the native crank (Slice 3).
- Seeker/MWA channel, multi-asset, deposit/withdraw UX polish, mainnet (Slice 4).

**Settlement model (locked):** player-`close` + permissionless `force_close` time backstop. **No keeper/crank in this slice** — so intra-round liquidation is not actively enforced. Acceptable here because it is devnet test-USDC. (Recorded risk: before real money, a keeper or the native crank MUST run, or players get a free lookback option that breaks house EV — not solvency. That enforcement is Slice 3 + mainnet.)

## Architecture

Browser-direct: the client talks to **L1** (custody) and **the ER** (the round) using the connected wallet to sign; **no backend sits in the money path.** Because a settled Round PDA can be re-opened without re-delegating, delegation is **once per session**, not per round:

```
Connect wallet ─▶ buy_in (L1, popup)                      fund PlayerBalance
            └──▶ delegate_session (L1→ER, popup, ~8s)     co-delegate player+house+round
   ┌─ GO     ─▶ open(dir,lev,stake) (ER, popup)
   │  …live…    HUD multiplier/car/liq-gauge driven by local RoundEngine sim,
   │            seeded from on-chain entry_raw, reading the live Lazer feed
   └─ CASH OUT▶ close (ER, popup)   settles on-chain (cashout/cap/liq), reads payout + balance
            … repeat GO/CASH OUT (no re-delegation) …
End session ─▶ commit_and_undelegate (ER→L1, popup) ─▶ withdraw (L1, popup)
```

Per-round cost is just `open` + `close` (2 popups); `delegate`/`undelegate` bookend the session. `force_close` (permissionless, post-deadline) is the liveness backstop. Clunky on purpose — Slice 2's session keys collapse the per-round popups.

In this slice, `player_authority` (the `open`/`close` signer on the ER) **is the owner wallet** (the program's two-authority slot is wired but a distinct session key is deferred to Slice 2).

## Components

### New
- **`src/core/chain-round.ts`** — the on-chain round client; replaces `round-sync.ts`'s server calls for the money path. Wraps the `raider` IDL via `@coral-xyz/anchor`, holds the L1 + ER connections, orchestrates `buy_in`/`delegate_session`/`open`/`close`/`force_close`/`commit_and_undelegate`/`withdraw`, and reads `PlayerBalance`/`Round`. **Bakes in the two devnet gotchas proven in the on-chain tests:** the `setComputeUnitLimit(400_000)` bump on `delegate_session`, and **HTTP-poll confirmation** (`sendRawTransaction` + `getSignatureStatuses` polling) on ER/heavy txs to dodge the rpc-websockets v9 `"Unknown action 'undefined'"` bug — never `.rpc()` confirmation on the ER provider.
- **`src/core/chain-config.ts`** — devnet program id, ER/L1 RPC + WS pins, BTC feed pubkey, test-USDC mint pubkey.
- **A dev-keypair `SolanaWalletPort` implementation** — backed by a local keypair (auto-signs, no popup), gated to devnet/dev only. Required so the loop is testable headlessly and in Claude Preview without a browser extension.
- **A test-funds helper** — mint the designated devnet test-USDC to the connected wallet + a SOL faucet nudge, so a fresh devnet wallet can play.

### Changed
- **`src/main.ts`** — GO / CASH OUT handlers call `chain-round` instead of `roundSync`; the play balance reads on-chain `PlayerBalance.balance`; the round result reads on-chain `Round.outcome`/`payout`.

### One-time devnet bootstrap (operator, not client code)
- A designated **stable devnet test-USDC mint** (so play balances persist across sessions), with `init_house` + `fund_house` run once against it (the house bankroll the client plays against).

## Data flow & the display/truth split

Same split the app already uses, with *truth* moved on-chain:
- **Display:** the client `RoundEngine` sim, seeded with the on-chain `entry_raw` (+ dir/lev/stake) and reading the live Lazer feed, drives the smooth live multiplier / car / liq-gauge during the round. No mid-round on-chain polling is needed (without a crank the Round PDA does not update mid-flight); chain state is read at `open` and at `close`.
- **Truth:** the on-chain `close` recomputes cashout/cap/liq with the fixed-point math the sim mirrors; its `payout` and the resulting `PlayerBalance.balance` are authoritative and shown as the final result.

## What stays untouched

`SolanaWalletPort` (wallet connect), `feed.ts` (Pyth Lazer + Hermes fallback), the Three.js scene + HUD, and `RoundEngine` (the sim). The **existing server stays running** for session/auth bootstrap and leaderboard; Slice 1 simply stops calling `/v1/round/*` and bypasses the old server-treasury deposit/withdraw path (buy_in/withdraw go direct to the program). Minimal blast radius.

## Error handling & recovery

- `delegate_session` ~8s land → "preparing session…" UI; CU bump + HTTP-confirm baked into `chain-round`.
- Insufficient SOL / test-USDC → clear error + the test-funds helper.
- Page reload mid-session → reconcile by reading on-chain `Round.status`: re-attach to a delegated open round, or (the audit's noted wrinkle) if the session was undelegated while a round was still open, **re-delegate then settle** — the on-chain analog of today's `roundSync.reconcile()`.
- Post-deadline → client calls `close` (settles, relabels to `time`); `force_close` is the backstop if the client vanishes.

## Testing

- **Headless TS integration test** (mirrors `onchain/raider/tests/*` style) driving `chain-round.ts` against devnet via the dev-keypair port: `buy_in → delegate → open → close → balance` assertions. Proves the client module before the browser.
- **Claude Preview** with the dev-keypair port: load redline3d, run a round, confirm the HUD reflects on-chain `PlayerBalance`/`Round`. (The "verify UI in browser before done" rule applies here — this is the first client slice with browser-testable surface.)

## Decisions / defaults

- **Use `@coral-xyz/anchor` in the browser** — reuse the IDL, matches the on-chain tests; slightly heavier bundle than raw web3.js, acceptable for this slice.
- **Keep the server for auth** — swap only the round path.

## Carry-forward (tracked, not in this slice)

- `require!(snap.price > 0)` guard on `flip`/`lever` + extend `feedauth.ts` negative tests to `force_close`/`tick_crank` — pre-Slice-3 / pre-mainnet hardening pass (bundled with the next program redeploy).
- `cancel_tick` / tight crank iteration sizing — when the crank goes client-side (Slice 3) and into the economics pass.
- Keeper/crank running before any real-money cutover (the EV gate above).
