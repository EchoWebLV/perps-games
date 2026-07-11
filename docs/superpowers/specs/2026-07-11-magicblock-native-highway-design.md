# MagicBlock-Native Highway and Currency-Ready SOL Architecture

**Date:** 2026-07-11
**Branch:** `codex/magicblock-native-highway`
**Status:** Design approved in conversation, pending written spec review

## Summary

Ship Highway as a MagicBlock-native, vault-backed perpetual game mode while leaving
the existing Track mode unchanged. Players open a real SOL-funded long or short,
their car drives automatically on the matching side of a shared highway, and their
chosen leverage controls visual speed. Positions have no timer. They remain open
until cash-out, liquidation, take-profit, stop-loss, or the existing payout cap.

The first release remains SOL-only, but all new money-facing client code reads a
currency configuration instead of assuming SOL decimals, labels, or wrapping. This
creates a safe path to add USDC later without mixing balances or silently swapping
assets.

MagicBlock remains essential. Player, house till, and Round accounts are delegated
to the Ephemeral Rollup for low-latency leverage updates, oracle-driven settlement,
and liquidation checks. The existing presence service only discovers participants;
the Round account remains the financial source of truth.

## Goals

- Enable the existing Highway gate and replace manual driving with automatic laps.
- Put long cars on one carriageway and short cars on the opposite carriageway.
- Let players choose leverage from 10x through 100x with a slider.
- Make leverage the input and car speed the visual output.
- Keep positions open until a financial terminal event, with no round timer.
- Restore the live Highway and car after the same wallet closes and reopens the app.
- Show other verified live positions on the same asset's Highway.
- Keep all financial actions vault-backed and executed through the existing Raider
  program and MagicBlock ER session.
- Introduce a SOL currency definition that later permits a separate USDC balance,
  vault, and funding path.
- Preserve existing Track behavior and timed rounds.

## Non-Goals

- No Flash Trade integration in this milestone.
- No SOL/USDC settings toggle or USDC vault in this milestone.
- No silent SOL/USDC swaps.
- No steering, throttle, collisions, or car-to-car financial interaction in Highway.
- No redesign of Track, crates, soft coins, scrap, or inventory.
- No user-funded public LP pool.
- No simultaneous SOL and USDC positions for one wallet.
- No per-frame position writes or presence transactions.

## Architecture

### 1. Currency boundary

Add a client-side `StakeCurrency` definition with:

- stable key and display symbol
- token mint and decimals
- stake minimum, maximum, and step
- funding mode: native wrap or SPL transfer
- amount parsing and formatting

The registry contains only `SOL` for this release. Existing chain-round, wallet,
HUD, controls, history, and Highway code consume the active definition instead of
hard-coded nine-decimal or `SOL` assumptions. Wrapped SOL remains an implementation
detail of the SOL funding adapter.

The Raider program already keys player, house, till, and vault accounts by mint, so
no currency-specific settlement rewrite is required. The existing Round PDA remains
one active position per wallet. A future USDC release can add another registry entry
and separate mint-keyed balances while still enforcing one active position globally.

### 2. Highway position mode

Reuse the existing Round account, house lock, price feed, settlement math, ER
delegation, crank, stop-loss, take-profit, grace, and airbag mechanics.

`deadline_ts == 0` is the canonical marker for an open-ended Highway position.
Timed Track rounds continue storing a positive deadline. Shared helpers must be used
for every time check so a zero deadline never fires a time settlement.

The existing open instruction accepts a dedicated protocol sentinel duration for
Highway. The client exposes that sentinel only through `openHighway`; Track continues
using bounded positive durations. This avoids a Round account resize or migration.

Permissionless `force_close` remains available only for timed rounds whose positive
deadline has elapsed. Highway positions can end through owner cash-out, cap,
liquidation, stop-loss, or take-profit. Highway does not introduce a privileged
settlement path.

### 3. Borrowing fee

Open-ended positions pay a fixed v1 borrowing fee of 1 basis point of notional per
24 hours. This equals 0.1% of collateral per day at 10x and 1% per day at 100x.

The fee accrues mathematically and is never submitted as an hourly transaction. It
is deducted from equity when a position is read for a terminal check, re-levered,
closed, or liquidated. Re-levering banks price PnL and the fee for the completed
segment, then reanchors the next segment at the confirmed oracle timestamp.

The current `banked` and `entry_ts` fields provide enough information for segmented
fee accounting, so the Round account does not need new fields. The fixed rate is a
protocol constant in v1. Runtime fee governance is deferred because it would require
stamping a rate into each position or introducing a versioned configuration account.

Borrow fees reduce the player's payout and therefore remain in the house. Fee math
must use checked integer arithmetic and the same fixed-point implementation in Rust
and the local preview engine.

### 4. Automatic Highway experience

Entering Highway opens the existing oval world in automatic-drive mode. The player
chooses asset, stake, direction, and leverage before opening.

- Long cars spawn on the long carriageway and travel clockwise.
- Short cars spawn on the short carriageway and travel counterclockwise.
- Direction is locked for the life of the position.
- Cars follow the oval centerline without steering or throttle input.
- The slider spans 10x to 100x in 10x confirmed steps.
- Dragging previews leverage and speed locally.
- Releasing the slider sends one coalesced ER `lever` instruction.
- Until confirmation, the UI shows the requested value as syncing and retains the
  last confirmed leverage as financial truth.

Visual speed increases monotonically with leverage but is clamped to keep every car
readable and stable. Speed has no direct financial effect beyond representing the
confirmed leverage. PnL controls glow and trail intensity. Liquidation proximity
controls smoke, sparks, and damage. Cash-out uses an exit animation; liquidation uses
a crash animation.

### 5. Persistence and reconnection

On wallet connection or app resume, the client derives the wallet's Round PDA and
checks base-layer delegation before trusting an ER clone. An open Round with
`deadline_ts == 0` identifies a Highway position and restores:

- asset and direction
- confirmed leverage and stake
- entry and banked PnL state
- stop-loss and take-profit state
- selected car and a deterministic lane and lap phase

The app enters Highway automatically after restoration. The car is animated from
current time and deterministic position metadata, so it appears to have continued
driving while the app was closed. No background browser process is required.

The existing permissionless crank remains responsible for liquidation and automatic
exits while the player is offline. MagicBlock scheduled tasks have a finite iteration
count, so `openHighway` arms 24 hours of one-second checks. Reconnection and every
confirmed owner action re-arm a fresh window with a unique task id. The position
itself does not expire when a schedule ends; the next owner action performs a
terminal-first check before changing state.

The devnet hackathon release must prove close-and-reopen behavior inside that window.
A mainnet launch is blocked until one of these production backstops is verified with
MagicBlock: a supported long-running recurring task, or a permissionless keeper that
monitors open Highway rounds and renews their finite schedules. The keeper cannot
select prices or payouts; it can only invoke the program's authenticated terminal
check.

If the Round settled while the app was closed, the app shows the stored result
instead of recreating a live car.

### 6. Verified multiplayer presence

Extend the existing presence payload with `mode`, `asset`, `roundPda`, `dir`, `lev`,
and a deterministic `laneSeed`. Presence is a discovery and rendering hint, not a
financial authority.

For every remote Highway car, the client verifies that its Round account:

- is open
- uses the advertised owner and asset feed
- has `deadline_ts == 0`
- matches the advertised direction and confirmed leverage

Invalid or stale entries are not rendered as live positions. Clients animate remote
cars locally, so the network does not receive frame-by-frame coordinates. Presence
loss degrades to solo Highway and never affects money.

Highways are partitioned by asset. BTC, ETH, and SOL positions do not contribute to
the same sentiment counts. The HUD shows long count, short count, and average
confirmed leverage for the active asset.

Only wallet-backed live positions appear on the public Highway. Practice cars are
local-only so spectators cannot confuse simulated positions with funded ones.

## Data Flow

### Open

1. Player selects SOL stake, asset, long or short, and leverage.
2. The SOL funding adapter wraps or transfers stake through the existing player
   balance flow.
3. `ensureSession` creates the house slice and delegates the session accounts.
4. `openHighway` opens a Round in ER with `deadline_ts == 0`.
5. The crank is armed and presence announces the verified Round PDA.
6. The car begins automatic laps at speed derived from confirmed leverage.

### Adjust leverage

1. Slider movement updates only the local preview.
2. Slider release snaps to a 10x step and enters syncing state.
3. Existing latest-wins lever synchronization sends at most one ER transaction at a
   time and coalesces newer requests.
4. The program applies accrued borrow fee and price PnL before reanchoring.
5. Confirmation updates the canonical leverage and public car speed.

### Close or liquidate

1. Cash-out or crank obtains an authenticated price snapshot.
2. Settlement includes price PnL, banked PnL, and accrued borrow fee.
3. The house lock is released and balances remain conserved.
4. The stored Round result drives the exit or crash animation.
5. Presence removes the live car and the normal undelegation and sweep flow runs.

## Error Handling and Safety

- Track rounds must produce byte-for-byte equivalent outcomes for existing cases.
- A zero deadline is valid only as open-ended, never already expired.
- `force_close` rejects open-ended positions.
- Fee growth uses checked arithmetic and caps at terminal zero equity rather than
  underflowing.
- A fee-only liquidation is possible after a sufficiently long flat market and must
  be handled by the crank.
- The hackathon build is devnet-only. Mainnet is disabled until continuous crank
  coverage is demonstrated for longer than the finite 24-hour client schedule.
- A failed leverage update restores the confirmed slider value and reports the error.
- If ER is unavailable, the client does not claim a leverage change succeeded.
- If presence is unavailable, the financial position continues in solo mode.
- Reconnection never adopts an ER clone when base-layer delegation says the account
  is no longer delegated.
- House undercapitalization keeps the existing refusal and recovery behavior.
- All public UI labels clearly identify the mode as vault-backed and onchain.

## Testing

### Rust unit tests

- Timed Track deadlines still fire at the same boundary.
- Zero-deadline Highway positions do not time-settle.
- `force_close` rejects a zero-deadline Round.
- Borrow fee is zero at entry, monotonic with time, and proportional to leverage.
- Borrow fee is banked exactly once across one or several leverage changes.
- Fee-inclusive cash-out, cap, and liquidation conserve player plus house value.
- A flat position eventually liquidates from fees when equity reaches the floor.
- Existing 38 Raider unit tests remain green.

### TypeScript unit tests

- SOL parsing, formatting, mint, decimals, stake bounds, and wrap adapter selection.
- Highway leverage snapping, preview, confirmed state, and speed mapping.
- Automatic long and short paths remain on separate carriageways.
- Reconnection identifies open Highway positions and ignores settled or timed rounds.
- Presence rejects unverified, stale, wrong-asset, and malformed Highway entries.
- Existing frontend and presence tests remain green.

### Integration and manual verification

- Local validator plus local ER: open, re-lever, cash-out, liquidate, undelegate.
- Devnet ER: close and reopen the app, restore the same position and car.
- Devnet ER: leave a client closed while a scheduled tick settles its position.
- Two clients on the same asset see verified cars on opposite carriageways.
- Mobile viewport and touch slider work without steering controls.
- Track still opens, runs, settles by time, and returns to the lobby unchanged.

## Delivery Order

1. Currency-ready SOL boundary with no visible behavior change.
2. Open-ended Highway and borrow-fee protocol math with Rust tests.
3. Client IDL and engine parity updates.
4. Automatic Highway, slider, HUD, and reconnect flow.
5. Verified multiplayer presence and sentiment display.
6. Full regression suite, build, local ER integration, and devnet smoke test.

Each step is committed independently so the branch can be bisected or reverted
without disturbing `main`.

## Deferred Work

- USDC registry entry, player balance, vault, deposit, withdrawal, and settings toggle.
- Flash Trade position provider.
- Runtime-governed borrow fee rates.
- Public LP deposits and shared-risk liquidity.
- Cross-asset Highway views.
- More than one simultaneous active position per wallet.
