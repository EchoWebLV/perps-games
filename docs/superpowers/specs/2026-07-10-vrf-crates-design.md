# VRF Crates — MagicBlock Verifiable Randomness for Crate Pulls

**Date:** 2026-07-10
**Branch:** intro-clarity
**Status:** Approved design, pre-implementation
**Hackathon context:** MagicBlock Blitz v6 (July 10–12, Mobile theme). The entry already runs its perp loop on a MagicBlock Ephemeral Rollup; this adds MagicBlock's second product — **ephemeral-vrf** — so every signed-in crate pull is rolled by verifiable on-chain randomness.

## Problem

Crate pulls (Wooden/Silver/Gold → car by rarity odds + scrap + level-skin roll) are rolled with client `Math.random()` behind the `RandomnessProvider` port in `redline3d/src/core/crate.ts`. The house could rig or predict pulls, and a player can't verify their odds were honored. The port was built for exactly this swap: "client RNG now, MagicBlock VRF behind the same port later."

## Decisions (locked)

- **Randomness source:** MagicBlock **ephemeral-vrf** (their oracle network + proof verification; program `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`, default devnet queue `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`). Non-negotiable — the hackathon story is MagicBlock.
- **Request signer:** the **player's wallet** (Privy embedded session wallet — the same silent signing the round loop uses). The randomness request is publicly tied to the player's own pull.
- **Program home:** a **new tiny standalone Anchor program** (`crate_roll`) in the existing `onchain/raider` Anchor workspace, deployed to devnet independently. The audited raider money program is untouched; crate VRF does not couple to the pending raider redeploy bundle.
- **Mapping:** randomness bytes on-chain, **car mapping off-chain** via the existing pure `rollCrate`/`pickLevel` math (Approach A). Provable by recomputation; roster/odds changes never require a redeploy.
- **Fail closed:** no silent fallback to client RNG for signed-in players. VRF unavailable ⇒ the crate does not open and coins are refunded.

## Non-goals

- Enforcing odds on-chain (roster/weights as on-chain config) — heavier, zero extra hackathon credit. Off-chain deterministic mapping is provable by recomputation.
- Stopping console cheaters from self-granting cars. VRF protects **players from the house** (no rigged/predicted pulls). Server-side grant authority is the Phase 2 entitlements co-sign track ([2026-07-09-server-authoritative-entitlements-design.md](2026-07-09-server-authoritative-entitlements-design.md)), not crates.
- Gasless VRF via an Ephemeral Rollup session (crates open in the lobby, outside ER sessions; delegating crate PDAs is machinery for zero devnet benefit). Mainnet optimization, later.
- The real-money `$` crate prices (still stubbed behind the payment rail).
- Guest crates change nothing: guests are walletless by design (local coins, practice parity) and keep `Math.random()`.

## Architecture

### On-chain: the `crate_roll` program (new)

Two instructions + one PDA. Uses `ephemeral_vrf_sdk` (Anchor feature) exactly per MagicBlock's integration pattern.

**PDA** `[b"roll", player]` → `RollSlot`:

| field | type | meaning |
|---|---|---|
| `player` | Pubkey | owner; only they can request |
| `nonce` | u64 | increments per request; identifies which request a fulfillment answers |
| `fulfilled` | bool | false between request and callback |
| `randomness` | [u8; 32] | the VRF output for `nonce` |
| `slot` | u64 | fulfillment slot (freshness/audit) |

**`request_roll`** (player signs, init-if-needed the PDA): `nonce += 1`, `fulfilled = false`, CPI `create_request_randomness_ix` with `caller_seed = keccak(player, nonce)`, callback pointed at `fulfill_roll`. One in-flight roll per player; a re-request supersedes a stale one (higher nonce wins).

**`fulfill_roll`** (VRF program invokes): requires `ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY` as signer (the SDK's enforced pattern — only MagicBlock's verified oracle path can fulfill), writes `randomness`, sets `fulfilled = true`, stamps `slot`.

No funds, no roster, no odds on-chain. Blast radius of a bug: crates fail to open; money can't be touched.

### Client: async draws behind the existing port

- **Derivation (fixed + documented):** `[u8; 32]` → 4 uniform draws in [0,1): bytes 0–7 as big-endian u64 / 2^64 → `rTier`; 8–15 → `rCar`; 16–23 → `rChance`; 24–31 → `rPick`. Pure function + test vectors; anyone can recompute a pull from the on-chain bytes.
- **`cratebox` gains an async provider seam:** `drawsProvider?: { draws(n: number): Promise<number[]> }`. When present (signed-in), the open path awaits it; absent (guest), the sync `RandomnessProvider` (client RNG) is used exactly as today.
- **VRF provider implementation:** send `request_roll` via the existing Privy session signer → poll the `RollSlot` PDA until `fulfilled && nonce == requested` (oracle round-trip is seconds; the crate-shake animation plays during the wait) → return the 4 derived draws.
- **Order of operations (integrity-critical):** coins are debited locally **before** `request_roll` is sent — the mapping is public, so randomness must never be knowable before payment (no peek-then-buy). The **server-side spend forward is deferred until fulfillment**: on success the spend posts with the pull's ref; on failure nothing was ever sent, so the local refund needs no server counter-entry (and can never be eaten by the earn-rate cap, which a `coinsEarn`-style refund would count against).
- **Reveal chrome:** the reveal card gains a small "⛓ MagicBlock VRF" chip (signed-in pulls only) — the visible fairness story for judges and players.
- **Welcome gift:** signed-in claim runs the same VRF flow minus the debit; guest gift stays local RNG.

### Data flow (signed-in pull)

buy tap → debit coins (existing `spend()`, server-synced) → `request_roll` tx (Privy silent sign, ~0.0005 SOL devnet faucet fee) → MagicBlock oracle computes + proves → VRF program verifies proof, CPIs `fulfill_roll` → client poll sees `fulfilled` → bytes → 4 draws → existing `rollCrate` + `dupeScrap` + `pickLevel` → reveal + grants through existing sync seams (`grantCar`/`addScrap`/`grantLevel`).

## Error handling

- **Request tx fails** (wallet unfunded, network): restore the local debit, toast, crate stays closed. No server traffic occurred (the spend forward is deferred to fulfillment), so local and server stay consistent by construction.
- **Fulfillment timeout** (~10s poll budget): same local restore + "Couldn't reach the randomness oracle — try again." A later stray fulfillment is ignored (nonce mismatch on the next request supersedes it).
- **Stale/replayed randomness:** impossible to reuse — each open re-requests with a fresh nonce; the client only accepts `nonce == requested`.
- **Guest path:** unaffected by any VRF failure mode (never touches the chain).

## Testing

- **Program:** callback rejects a non-VRF-identity signer; nonce lifecycle (request bumps + clears, fulfill sets, supersede works); only the player can `request_roll` their PDA.
- **Client unit (vitest):** derivation test vectors (fixed 32 bytes → exact 4 draws); async-provider path feeds `rollCrate` identically to sync draws; timeout → refund + closed state; nonce-mismatch fulfillment ignored.
- **Live devnet:** one end-to-end browser pull — buy → real VRF round-trip → reveal — before the feature is called done (per the standing browser-verification rule).

## Deploy

- `anchor build` in the existing workspace now also produces `crate_roll` (its own program ID + IDL); `anchor deploy -p crate_roll` to devnet — raider untouched, no house re-init, no raider IDL regen.
- Client gets the `crate_roll` IDL + program ID (same pattern as the raider IDL under `redline3d/src/chain/idl/`).
- Player wallets already hold devnet gas (the round loop funds them); the VRF fee is ~0.0005 SOL faucet SOL per pull.

## Phasing

Single implementation plan (one subsystem): program + client provider + cratebox seam + reveal chip + tests + devnet deploy/verify.
