# In-game "How to Play" — paged walkthrough

**Date:** 2026-07-09
**Branch:** intro-clarity
**Status:** design — awaiting approval → implementation plan

## Goal

Onboard first-time players of Perps Rider with a short paged walkthrough that explains the
game in plain player terms — especially the confusing part: a real leveraged perp skinned as
arcade racing. Shown once automatically to new players (right after the identity gate, before
their free Wooden crate) and always available from the hamburger menu.

## Why

New players currently get almost nothing: the old in-race control hint was deleted, and the only
tutorial is a static 3-line panel buried two taps deep in the hamburger (`carpicker.ts` "help"
view, never shown proactively). For a genre-mashup real-money game this is a launch gap.

## Scope

- **New:** a paged walkthrough overlay (`ui/howto.ts`), 6 cards.
- **New:** first-run auto-show (once, durable flag), sequenced before the existing free Wooden crate.
- **Change:** the hamburger "How to play" row opens the new overlay instead of the inline static
  panel; remove the old inline "help" view from `carpicker.ts`.
- **Fix (same pass):** the CRATES lobby door still reads "coming soon" though crates fully work —
  update the copy.
- **Unchanged:** all gameplay, the welcome-crate logic itself, every other menu row.

## Content — 6 cards (plain terms, reusing the game's exact on-screen labels)

Copy is grounded in the real UI strings (verified in `controls.ts`, `hud.ts`, `tach.ts`,
`lobbyhud.ts`, `identity.ts`). Each card = a title + 1–2 lines + an icon/emoji.

1. **Drive** — "Hold the road to drive. Drag to steer, pull back to brake, release to coast."
   *(sub, desktop only: "Keyboard: W/S gas & brake, A/D steer.")*
2. **Race the price** — "Drive into **TRACK**. Call it: **▲ Long** if you think the price goes up,
   **▼ Short** if it drops. Set your **play amount**, then tap **GO!**"
3. **Rev for leverage** — "Hold the gas to rev — more revs = higher leverage (**×**), and every
   price move hits bigger. The dial shows your leverage."
4. **Win or wreck** — "The big number is your live multiplier — **green** when you're up, **red**
   when you're down. Tap **CASH OUT** while you're up to bank it. Drop too far and you're
   **💥 Liquidated** — you lose the play amount. Beat the clock."
5. **Practice or real** — "As a guest you're in **practice** mode — free, nothing at stake, learn
   all you want. **Sign in** to play for real SOL."
6. **Earn & upgrade** — "Grab **coins** and **scrap** on the track. Spend coins at **UPGRADES**
   (more leverage, longer rounds) and **CRATES** (win new cars). Find your ride in the **GARAGE**."

## UX

- One card at a time; the game's neon / Chakra-Petch panel style (match `cratebox`/`carpicker`).
- Progress **dots** (6); **‹ ›** arrow buttons + **swipe** (touch) + **←/→** keys to move.
- **Skip** affordance (top corner) on every card; the last card's primary button reads **"Let's go"**
  and closes. Closing (skip or finish) fires an `onClose` callback.
- Overlay dims the scene behind it (blur, like the other panels); Esc / backdrop-tap closes.

## Placement / triggers

- **First run:** once ever, keyed off durable flag `raider.howto.v1` (mirrors the
  `raider.welcome.v1` once-ever pattern). Shown from the gate's success path (guest **and**
  sign-in), and its `onClose` then triggers the existing free-Wooden-crate flow — so the order is
  **gate → How to Play → free crate → lobby**. No grandfathering: any player without the flag sees
  it once (existing testers included — it's skippable), which also doubles as the verification path.
- **Menu:** the hamburger "How to play" row (`carpicker.ts`) opens the same overlay via a new
  `onHowTo` callback dep, wired in `main.ts`.

## Module plan (small, bounded units)

1. **`src/ui/howto.ts` (new)** — `createHowTo(parent) -> { open(onClose?: () => void): void; isOpen(): boolean }`.
   Owns the 6-card data, the paged DOM, paging/swipe/keys, and its own injected styles. Plus pure,
   injectable flag helpers `howToSeen(store)` / `markHowToSeen(store)` on key `raider.howto.v1`
   (store defaults to the same `browserStore`/KvStore used by `welcome.ts`), unit-tested.
2. **`src/ui/carpicker.ts` (edit)** — the "How to play" menu row calls a new `onHowTo` dep instead
   of `setView("help")`; remove the inline `"help"` view + its static panel HTML and the enum member.
3. **`src/main.ts` (edit)** — `const howto = createHowTo(hudRoot)`; pass `onHowTo: () => howto.open()`
   into `createCarPicker`; in the gate success path, if `!howToSeen()` call
   `howto.open(() => { markHowToSeen(); maybeWelcomeGift(); })`, else `maybeWelcomeGift()` directly
   (preserving today's behavior for returning players).
4. **`src/ui/lobbyhud.ts` (edit, copy)** — CRATES `OFFERS` desc `Loot crates — coming soon` →
   `Loot crates — win new cars`.

## Testing & verification

- **Unit (TDD):** `howToSeen`/`markHowToSeen` idempotence + durability against an injected KvStore
  (mirror `welcome.test.ts`). Existing suites stay green.
- **Browser (main session):** first boot (cleared `raider.howto.v1`) → walkthrough auto-shows →
  page through all 6 → "Let's go" → free Wooden crate follows → lobby; reopen from the hamburger
  "How to play"; swipe + arrows + dots work; CRATES door no longer says "coming soon". `?perf=low`
  sanity (pure DOM, tier-independent).
- `tsc --noEmit` clean; full suite green.

## Non-goals

- No interactive/coach-mark tutorial over live gameplay (this is a read-through screen).
- No new art assets (emoji/CSS icons only).
- No change to the perp mechanics, the welcome-crate reward, or wallet/real-money copy elsewhere
  (the broader jargon-leak cleanup — `sim`, `Settling…`, `devnet`, `wraps` — is tracked separately).
