# First-login free Wooden crate — design

**Date:** 2026-07-07 · **Branch:** `intro-clarity` · **Client:** `redline3d/`

## Goal

A brand-new player's first arrival should hand them a car beyond the Starter and teach
the crate mechanic in one motion: after they pick a driver name at the identity gate, a
**free Wooden crate auto-opens** with the full reveal, then drops them onto the strip.

## Behavior

1. Fresh visitor boots → identity gate (no prior identity) → they pick a name as **guest**
   or **sign in**.
2. Gate closes → one tick later the **Crate Shop opens itself straight into a Wooden open**:
   the crate shakes → bursts → reveals their first car (NEW badge, `+25` scrap chip, and the
   normal 5% level-skin roll — a full wooden open, just free).
3. **Done** returns them to the strip, ready to drive.

They already own `Starter` (`pool:false`, never rolled), so the pull is always a *fresh*
car on **normal wooden odds** (C50 / U30 / R20). No rarity floor, no odds change.

## Once-ever, new-players-only

- **Flag:** `raider.welcome.v1` in localStorage — set the moment the gift fires, checked
  before it fires. Decoupled from identity, so log-out / switch-driver never re-grants.
- **Arm:** only when `freshVisitor = !loadIdentity()` captured at boot (a browser with no
  prior identity).
- **Grandfather:** at boot, any player who *already* has an identity gets the flag set
  silently (no gift), so existing players are never retroactively handed a crate.
- **Accepted residual:** a player from before this feature who is currently logged out and
  reboots gets one wooden crate. Harmless (cheapest tier, client-side).

Decision helper (pure, unit-tested): `shouldGrantWelcome(freshVisitor, claimed) =
freshVisitor && !claimed`.

## Code seams

1. **`src/ui/cratebox.ts`** — `doOpen(crate)` → `doOpen(crate, free = false)`: when `free`,
   skip the coin-balance check and the debit; everything downstream (roll → grant → scrap →
   level → animate → reveal) is unchanged. Add `openGift(key)` to the `CrateBox` interface
   (render the 3D assets, show the overlay, run a free open) and a `giftMode` flag so the
   reveal's **Done** closes to the strip instead of showing the buy-grid. Defensive: if the
   roll returns null, mark welcomed and close (no infinite retry).
2. **`src/main.ts`** — capture `freshVisitor` at boot; grandfather returning players
   (`if (identity) markWelcome()`); in the gate's `onGuest` / `onSignIn` success, after
   `saveIdentity` + `syncOnchainBalance`, fire `crateBox.openGift("wooden")` one tick after
   the gate closes (`setTimeout(…, 0)`), guarded by `shouldGrantWelcome(...)` + `markWelcome()`.

No changes to the roll logic/odds, the crate config, or the Starter name.

## Testing

- **Unit:** `shouldGrantWelcome` truth table (fresh+unclaimed → true; every other combo →
  false).
- **Browser (primary proof):** clear localStorage → reload → clear the gate → confirm the
  wooden crate auto-opens, reveals a **NEW** car, garage shows it, scrap banked, flag set →
  reload again → **no** second gift. Repeat via the sign-in door.

## Out of scope (separate follow-ups)

- **Cards → NFTs** — its own subsystem (on-chain mint, wallet-bound ownership, marketplace).
  Brainstormed separately.
- **Renaming the Starter car** ("Sean-Claude Van Dam") — declined for now; stays `Starter`.
