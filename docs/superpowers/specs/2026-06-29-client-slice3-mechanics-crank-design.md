# Client Phase — Slice 3: Mid-round mechanics + native crank (design)

**Date:** 2026-06-29
**Branch:** `onchain-er-rebuild`
**Status:** design — pending user review before writing-plans
**Predecessor:** Slice 1 (`docs/superpowers/specs/2026-06-29-client-phase-slice1-onchain-round-design.md`) — built & browser-verified on devnet.

## Goal

Turn the Slice-1 wiring proof into the actual game loop on devnet: **open arms the on-chain MagicBlock crank** so the validator auto-settles liquidation/cap/time with **zero client tx**, and the player can **flip** (lane-bet, reverse direction) and **lever** (throttle, change leverage) mid-round. This closes the intra-round-liquidation EV gap that Slice 1 explicitly left open (player-close + time-backstop only).

## Context

The `raider` program already ships all of this (Phase 2, green on devnet): `flip(new_dir)`, `lever(new_lev)` (terminal-first, banked-aware), `tick` (permissionless keeper), `tick_crank` (no-signer, validator-run), and `schedule_tick(task_id, interval_ms, iterations)` (arms the native crank via a `ScheduleTask` CPI). Slice 3 is purely client-side: wire these into `chain-round.ts` and the `onchain.html` demo. All paths are owner-signed or permissionless, so the existing **dev-keypair auto-sign port** drives everything — no session keys needed (that's Slice 2, deferred).

This stays on the minimal `onchain.html` entry; folding into the real 3D game UI (`main.ts`) is the next slice after this. The existing server stays dormant.

## Scope (locked)

**In scope:** `flip` + `lever` mid-round (owner-signed, on the ER); arming the native crank at `open` so a round auto-liquidates with zero client tx; an on-chain `Round` status poll in the demo frame loop so a crank/keeper settlement surfaces in the HUD even when the player is idle; funding the dev wallet's crank escrow on devnet.

**Out of scope (later slices):** session keys (Slice 2); the real 3D game UI / `main.ts` rewire and the Clown-Car/throttle skin (Slice 4); multi-asset; mainnet; the client-side keeper loop (the native crank is the chosen single driver); `cancel_tick` (not in the program — leftover crank iterations no-op).

## Architecture

Extends Slice 1's `chain-round.ts` + `onchain.html` (dev-keypair, devnet, `main.ts` untouched). The round lifecycle gains the crank arm and mid-round actions:

```
open(dir,lev,stake) ─▶ schedule_tick   (arm native crank once, owner-signed, on the ER)
   │                      validator now auto-runs tick_crank ~every 1s → settles liq/cap/time, 0 client tx
   ├─ FLIP(newDir)  ─▶ flip(newDir)     (ER, owner-signed; terminal-first: settles if already liq/cap/time)
   ├─ LEVER(newLev) ─▶ lever(newLev)    (ER, owner-signed; terminal-first)
   ├─ CASH OUT      ─▶ close
   └─ (player idle) ─▶ CRANK settles it on its own           ← the new EV-correct behavior
frame loop polls on-chain Round (status/outcome/payout) ~1.5×/s → finalizes on any settlement (crank OR close)
```

## Components

### `chain-round.ts` additions
- `flip(newDir: 1 | -1): Promise<FlipResult>` and `lever(newLev: number): Promise<LeverResult>` — send the ER instructions (owner-signed, `Context<CloseRound>` accounts, same as `close` plus the arg). Both are **terminal-first**: each returns either the re-anchored round (`{ settled: false, banked, dir, lev, entryHuman }`) or a settled result (`{ settled: true, ...SettledRound }`) when the live mark already crossed liq/cap/time.
- `scheduleCrank(opts?): Promise<void>` — send `schedule_tick` on the ER right after `open` (default interval 1000ms; iterations over-provisioned to cover the 60s cap, e.g. ~70; leftover ticks no-op after settle, per the program's no-`cancel_tick` reality). `task_id` is a fresh per-round id.
- `readRound(onEr?): Promise<RoundSnap>` — full on-chain Round snapshot (`status`, `outcome`, `payout`, `banked`, `dir`, `lev`, `entryHuman`) for the frame-loop poll.
- **Crank escrow:** the validator bills the schedule-payer's MagicBlock SOL escrow. The dev wallet self-funds on devnet. The exact funding call/path is confirmed against the Phase-2 `onchain/raider/tests/tick-liq-crank.ts` during planning (known-unknown: whether the crank draws from the payer's ER lamports or a dedicated escrow deposit). Not a design blocker.

### `onchain-main.ts` additions
- **FLIP** button (reverses dir) + **lev −/+** controls; on each, call `chain.flip`/`chain.lever`, then mirror in the local display engine (`engine.setDir(newDir, price)` / `engine.setLeverage(newLev, price)`) so the smooth × stays believable. If the call returns `settled: true`, finalize like a close.
- Arm the crank immediately after a successful `open` (`scheduleCrank()`), with a clear status line if the escrow is underfunded (round still playable, just not auto-settled).
- Frame loop polls `chain.readRound()` ~1.5×/s; on `status == 2` (from the crank or a close) it finalizes: shows the on-chain outcome/payout, refreshes the on-chain balance, ends the round — so a **crank-driven liquidation appears even if the player never clicks**.

## Display / truth split

Unchanged principle: the local `RoundEngine` drives the smooth × for feel; the on-chain `Round` is the only truth. New wrinkle: the round can now settle **without player action**, so the periodic on-chain status poll is what bridges a crank settlement to the HUD. flip/lever update both the on-chain `banked`/`entry`/`dir`/`lev` and the local engine; small divergence between the client feed and the ER feed at the action instant is acceptable (on-chain close/crank is authoritative).

## Crank lifecycle

`schedule_tick` arms the validator to run `tick_crank` `iterations` times at `interval_ms`. After settle, remaining iterations no-op (status != 1). There is no cancel path in the program, so iterations are sized to the round, not cancelled — leftover no-ops bill the schedule payer's escrow (the known Phase-2 economic item; sized into economics later, not this slice). The crank is the single intra-round driver this slice (keeper path not wired).

## Error handling

- Crank escrow underfunded at open → warn in the status line; the round is still playable (player can close manually) — the crank just won't auto-settle.
- `flip`/`lever` returning a settled result (terminal-first hit) → finalize exactly like a close (show outcome/payout, refresh balance, end round).
- The on-chain `readRound` poll is the safety net: any settlement (crank, keeper, or close) is surfaced even if a client call dropped its response.
- The Slice-1 gotchas remain in force (HTTP-poll confirmation, ownership-poll delegate/undelegate, `entryRaw·10^(-expo)` conversion, `.accountsPartial`).

## Testing

- **Headless devnet integration** (`chain-round` driven, gated like Slice 1's): open + `scheduleCrank` → `flip` → `lever` → then **stop touching it** and assert the **crank settles the round to `status=2` with zero client `close`/`tick`** (the EV-closing proof; mirrors `onchain/raider/tests/tick-liq-crank.ts`). Uses the `test-long-deadline`/180s consideration only if a calm-market liq needs the longer window — otherwise a high-leverage open makes the crank liquidate quickly.
- **Claude Preview** (per the verify-UI-in-browser rule): click FLIP / lev± and confirm the HUD + on-chain state update; then open a high-leverage round and **watch it liquidate on its own** via the crank (no CASH OUT click), the HUD showing the on-chain outcome — the visible proof the money model is now enforced.

## Decisions / defaults

- Native crank is the **single** intra-round settlement driver (no client keeper this slice).
- Crank interval **1s**, iterations sized to the 60s cap.
- flip/lever exposed as plain buttons in the demo (the Clown-Car lane / throttle skin is Slice 4).
- The dev wallet self-funds its crank escrow on devnet.

## Carry-forward (tracked, not in this slice)

- Real 3D game UI fold (`main.ts` → chain-round) — the next slice (what the user wants to play).
- Session keys (Slice 2) — zero-popup once a real wallet is connected.
- Crank-escrow sponsorship model (house-funds-the-crank vs player-funds) + iteration sizing → economics pass.
- The pre-mainnet program hardening bundle from the Phase-0–2 stress test (`snap.price > 0` on flip/lever; `feedauth.ts` negatives for force_close/tick_crank).
