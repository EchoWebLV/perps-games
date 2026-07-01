# Pink Rod "Auto-Exit" — SL/TP slider UI (design)

**Date:** 2026-07-01 · **Branch:** `onchain-er-rebuild` · **Scope:** client-only (no program change, no migration)

## What

The Pink Rod car's ability: two pre-round thresholds — a **stop-loss** and a **take-profit** — that the
on-chain tick/crank auto-cashes-out at. The program side already exists and is devnet-proven
(`Round.sl_fp` / `Round.tp_fp`, commit `eedff75`): SL is clamped strictly above the liq floor (a gap
through SL still liquidates), TP strictly below the ×25 cap, both settle as a normal Cashout at the
observed mark. Every car currently passes `sl = tp = 0` (off). This spec adds the control that feeds
real values for the Pink Rod car only.

## UX

- **New "Auto-Exit" panel** in the pre-round control stack (`hud.ctrlMount`, appended after the
  play-amount box), styled like the existing panels (`--panel` background, `.lbl` labels, `.num` readouts).
- **Gated to the Pink Rod car**: shown only when `ability === "pinkRod"` (same `setAbility` pattern as
  nitro/skull). Absent (`display:none`) for every other car.
- **Locked during a live round**: values are stamped at GO; while live the panel dims (opacity ~0.45)
  and ignores pointer events — the pre-round settings pattern (play amount behaves the same way).
- **Units = equity-×** — the same multiplier the HUD shows. "Stop ×0.50" = auto-bail at half equity;
  "Take ×3" = auto-cash-out at 3×. (On-chain equity and HUD equity are the same quantity.)
- **Two sliders with discrete stops + an OFF position at the safe end. Default = both OFF** (identical
  behavior to today; no other car changes at all).
  - **Stop-loss**: `OFF · ×0.25 ×0.3 ×0.4 ×0.5 ×0.6 ×0.7 ×0.8 ×0.9` (OFF at far left; right = tighter
    stop). The minimum 0.25 stays above both possible liq floors (0.20 default / 0.10 Suspension-maxed),
    so the UI can never request a value the program would clamp into the floor.
  - **Take-profit**: `×1.5 ×2 ×3 ×4 ×5 ×7 ×10 ×15 ×20 · OFF` (OFF at far right; left = quicker
    profit-take). Discrete stops give resolution where it matters (1.5–5) instead of a linear 1.5–25 ramp.
- Each row: a small label ("stop" / "take"), the slider, a live `×N` / `OFF` readout. Slider accent =
  the game's magenta (`#ff39c0`) — on-theme for the Pink Rod.
- Player copy only ("auto-exit", "stop", "take") — no chain/session jargon.

## Architecture

Follows the nitro pattern: a **pure, DOM-free core** + a thin DOM view.

- **`src/ui/pinkrod.ts`** (new)
  - `SLS = [0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]`, `TPS = [1.5, 2, 3, 4, 5, 7, 10, 15, 20]`.
  - `createAutoExitCore()` — holds the two slider indices; `values()` returns
    `{ slFp, tpFp }` in on-chain SCALE units (`Math.round(x * 1_000_000)`), `0` for OFF;
    label helpers (`"OFF"` / `"×0.5"` via `String(v)`).
  - `createAutoExit(mount)` — appends the panel, wires slider `input` events to the core, and returns
    `{ setEnabled(on), setLive(on), values() }`.
- **`src/ui/carpicker.ts`** — `CarAbility` union += `"pinkRod"`; new `target` (crosshair) icon.
- **`src/main.ts`** — instantiate after `createControls`; `setAbility` adds
  `autoExit.setEnabled(a === "pinkRod")`; the Pink Rod card becomes
  `ability: "pinkRod", power: { name: "Auto-Exit", desc: "auto cash-out at SL / TP", icon: "target" }`;
  the GO handler passes `ability === "pinkRod" ? autoExit.values() : { slFp: 0, tpFp: 0 }` into the
  existing `session.open(…, graceSecs, slFp, tpFp)`; `setLive(true)` on successful open,
  `setLive(false)` in `finalizeSettled` and on open failure.

Deliberately deferred (not in this slice): SL/TP tick marks on the live liquidation gauge.

## Data flow

Slider index → core → (at GO, Pink Rod only) `values()` → SCALE fp ints → `session.open` →
`chain-round.open` → on-chain `Round.sl_fp / tp_fp` → the crank's `tick_action` fires the exit →
existing settle poll → `finalizeSettled` shows the normal "Settled at ×N. Banked …" line.

## Error handling

- OFF ⇒ exactly `0` on-chain (the program's "unset" sentinel) — no behavior change vs today.
- The program still clamps whatever it receives (SL into `(liq_fp, 1)`, TP into `(1, cap)`), so a
  client bug can't produce an exploitable threshold; the UI ranges are chosen to never hit the clamps.
- Open failure: panel unlocks with the round (`setLive(false)` in the catch path).

## Testing

- **`src/ui/pinkrod.test.ts`** (new): defaults are OFF ⇒ `{0, 0}`; each index maps to the exact fp
  value (`×0.5 → 500_000`, `×3 → 3_000_000`); OFF positions (sl 0 / tp last) ⇒ 0; label formatting.
- tsc + full vitest suite green.
- **Browser (devnet, Claude Preview)**: pick Pink Rod → panel appears (and not on other cars) → set
  stop ×0.9 / take ×1.5 → GO → read the Round off the ER and assert `sl_fp = 900_000`,
  `tp_fp = 1_500_000` stamped → round settles (SL/TP fire if the market crosses one, else the normal
  cap/time path) → panel unlocks. The firing logic itself is already unit-tested + devnet-proven on
  the program side; the UI's job is stamping the right values.
