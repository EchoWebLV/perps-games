# Server-Authoritative Economy & On-Chain Entitlement Co-Sign — Design

**Date:** 2026-07-09
**Branch:** intro-clarity
**Status:** Approved design, pre-implementation

## Problem

Two confirmed findings from the security review are, at root, the same problem:

1. **On-chain perks are caller-controlled.** `open` (raider program) accepts leverage, duration, grace, stop-loss/take-profit, and airbag-refund parameters from the caller and only clamps them to *global* bounds — it never verifies the caller owns the car or upgrade levels those perks require. A direct RPC caller can request maximum everything.
2. **The economy is not authoritative.** Economy endpoints accepted anonymous sessions (anonymous minting), the client cache could seed a fresh account with another account's state (cross-account migration), and coin/scrap earning is client-supplied.

Because coins buy cars and cars set real-payout perk parameters, (2) feeds (1): free coins → free cars → free real-money perks. The unifying fix is to **make the server authoritative over the economy, and have it cryptographically authorize what a player may do on-chain.**

## Decisions (locked)

- **Enforcement mechanism:** the server's entitlement key is a **required second signer on `open`**. Native Solana signature verification; the player still signs their own stake, so custody is unchanged.
- **Earn authority:** the server is the **source-of-truth ledger + coarse anti-abuse bounds**. Not full per-event validation.
- **Sequencing:** Phase 1 (authoritative economy + entitlement oracle) is a prerequisite for Phase 2 (co-sign).

## Non-goals

- **Full server-authoritative earning** (validating the game event behind every minted coin). Out of scope; a separate, larger project. We add coarse rate/amount bounds only. A determined player can still slightly over-report driving pickups, but cannot turn that into unbounded real-payout advantage once perks are gated.
- **Lowering leverage.** Global RMAX 3000 is untouched. Entitlements tie the leverage a player *uses* to the Turbo Kit level they actually earned. (Consistent with the standing "2000× is non-negotiable" rule.)
- **The autonomous cash-round settler.** The P0 guard fail-closes cash rounds until it exists; building the settler is separate work.
- **The "cash payouts not collateralized" finding** — separately excluded from this fix pass.

## Architecture

### The shared entitlement module (one authoritative computation)

`redline3d` already consumes `@perps/engine` (`src/core/{leverage,economics,config,types}.ts` are thin `export *` re-exports), so a shared package is the natural home.

Add an **`entitlements` module to `@perps/engine`** that computes, from `(ownedCars, equippedCar, upgradeLevels)`, the perk envelope:

| Field | Source |
|---|---|
| `maxLev` | Turbo Kit level → RMAX; plus any car `baseLev` floor (e.g. Cybertruck 1500×) |
| `maxDurSecs` | Long-Range Tank level → MAXSEC |
| `minLiqFp` | Suspension level → liq floor, clamped to on-chain `MIN_LIQ_FP` (0.10) |
| `graceSecs` | non-zero only if the equipped car's ability grants it (Skull) |
| `slTpAllowed` | true only for Pink Rod |
| `refundFp` | non-zero only for Flintstone/Bedrock airbag, clamped to `MAX_REFUND_FP` (0.20) |
| `maxStake` | per-car cap |

This logic currently lives spread across `redline3d/src/main.ts` (`CAR_DEFS`: ability, `baseLev`, per-car cap), `redline3d/src/ui/upgrades.ts` (`trackValue` for RMAX/MAXSEC/LIQ), and the on-chain `settle.rs` constants. Consolidate the envelope computation into the shared module. **One implementation:** the server imports it as the authority; the client imports the same code for display and to build its request. Shared test vectors lock client/server parity.

### Phase 1 — Server-authoritative economy

1. **Wallet-bound economy writes** — *landed in this fix pass (server worker).* coins/scrap earn+spend, inventory grant/melt, and migrate require a wallet-bound session (`requireWalletBoundUser`, 403 otherwise). Closes anonymous minting.
2. **No cross-account migration** — *landing in this fix pass (client worker).* Local state only seeds the wallet that produced it.
3. **Authoritative upgrade levels (new — a real gap).** Turbo/Tank/Suspension levels — which set `maxLev`/`maxDurSecs`/`minLiqFp`, the most consequential perk inputs — are currently **client-only** (`redline.garage.v1` localStorage in `upgrades.ts`); the server's `me`/`migrate` payloads carry only `{coins, scrap, cars}`. Phase 1 must persist upgrade levels server-side and make the server authoritative for them (extend the inventory/account model + the sync in `account-sync.ts`), or `entitlementsFor` cannot be trusted.
4. **Coarse earn bounds (new).** A per-user rolling cap on reported coin/scrap earns that rejects an implausible mint rate. Defense-in-depth, not a full economy model. Server-authoritative credits (on-chain round payouts, real-money crate purchases) are distinguished from client-reported driving pickups (the bounded path).
5. **Entitlement oracle (new).** `entitlementsFor(userId)` on the server reads the authoritative inventory (owned cars + upgrade levels) and returns the perk envelope via the shared module. This is the bridge to Phase 2.

### Phase 2 — Entitlement co-sign on `open`

**On-chain (raider program):**
- Add `entitlement_authority: Pubkey` to `HouseBalance`. The master holds it (admin-set at `init_house`, plus a rotate instruction); `slice_from_pot` stamps it onto the per-session till exactly as it already stamps `authority` and `max_slice`. **This is why it lives on the till:** `open` executes *inside the MagicBlock ER* against co-delegated PDAs and cannot read a global config account there — baking the authority into the till at slice-time (on L1) makes it readable in-rollup with no extra delegated account. (Composes with the just-added `max_slice`: `HouseBalance::SIZE` grows again, one more field.)
- `OpenRound` gains a required `entitlement_authority: Signer<'info>`; `open` does `require_keys_eq!(entitlement_authority.key(), house.entitlement_authority)` (house = the co-delegated till). Global clamps stay as defense-in-depth.
- The operator's co-signature covers the whole transaction, so it attests the exact perk args — the program does **not** recompute the envelope; it only verifies the trusted key signed.
- **Key hygiene:** the entitlement authority is a *separate hot key* that can only authorize opens. It cannot move bankroll — that stays the cold house `authority`.

**Server:**
- `POST /v1/round/authorize`: authenticate the wallet-bound user → compute `entitlementsFor` → validate every requested perk ≤ envelope → co-sign the open transaction with the entitlement key → return the co-signature. Reject over-entitled requests (client tampering / cache drift).
- The entitlement signing key is a server-held secret, distinct from the treasury and house-admin keys.

**Client:**
- The `game-session` open flow builds the open tx with its *requested* perks (from the equipped car + levels), calls `/authorize`, attaches the returned co-signature, then the player's wallet signs and submits to the ER.
- **Fail closed:** server unavailable or co-sign refused → GO surfaces "couldn't authorize the round," nothing opens.

### Data flow (a money-round GO under Phase 2)

GO (signed-in) → client builds open tx with requested perks → `POST /authorize` → server validates against authoritative inventory + co-signs → wallet signs → submit to ER → `open` verifies the entitlement co-signer → stamps perks. No valid co-signature ⇒ no round. A direct RPC caller who skips the server cannot produce the signature.

## Error handling & edge cases

- Server down / co-sign refused → fail closed (no round opens).
- Requested-perk mismatch (cache drift or tampering) → server rejects; client resyncs its cache (server wins).
- Key rotation → admin updates `master.entitlement_authority`; new tills carry the new key; in-flight tills carry the old key until swept (short-lived, acceptable).
- Guest / practice mode is unaffected — it never opens on-chain.
- The co-sign adds one server round-trip to the GO critical path (accepted).

## Implementation risks (de-risk in this order)

1. **ER multi-signer support — highest risk, validate first.** Confirm on devnet that the MagicBlock ER accepts a transaction with a required non-fee-payer co-signer on `open`. **Fallback if not:** the signed-permit (Ed25519) mechanism — the server signs a short-lived entitlement envelope; the program verifies it via the Ed25519 program + instruction introspection; the client reuses it across opens. The Phase 2 plan's first task proves this before anything else is built.
2. **HouseBalance layout growth.** `entitlement_authority` grows `HouseBalance` again (after `max_slice`). Requires a devnet re-init — bundle both layout changes into one redeploy.
3. **Latency.** The co-sign round-trip is on the GO path. Measure it; if it hurts Seeker feel, cache a short-lived permit (converges with the Ed25519 fallback).

## Testing strategy

- **Shared module:** unit tests + client/server parity vectors — each car/upgrade combination → expected envelope.
- **On-chain:** `open` fails with no signer and with a wrong signer, succeeds with the right one; the till carries the stamped `entitlement_authority` from slice; existing settle/solvency invariants unchanged.
- **Server:** `entitlementsFor` per inventory state; `/authorize` rejects over-entitled requests and co-signs valid ones; earn bounds reject implausible rates; upgrade-level authority round-trips.
- **Client:** `/authorize` round-trip integration; fail-closed path on server error; requested perks derived from the shared module.

## Deployment / migration ripples

Carried over from the on-chain security-fix pass, plus Phase 2:
- Regenerate the client IDL (`redline3d/src/chain/idl/raider.{ts,json}`) from `anchor build`.
- Update `initHouse` callers (`redline3d/scripts/bootstrap-devnet.mjs`) for the new `max_slice` arg (and later the entitlement-authority setter).
- Devnet redeploy + house re-init for the `HouseBalance` layout changes (`max_slice` now, `entitlement_authority` in Phase 2) — same re-home pattern as the prior `house`→`house2` migration.

## Phasing (each gets its own implementation plan)

- **Phase 1 plan:** shared entitlement module + server-authoritative upgrade levels + coarse earn bounds + `entitlementsFor` oracle. (Wallet-bound writes and the cross-account-migration guard already land in the current fix pass.)
- **Phase 2 plan:** on-chain co-sign (validate ER multi-signer support first) + `/authorize` endpoint + client open-flow integration + the deployment ripples above.
