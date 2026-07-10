# VRF Crates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in crate pull is rolled by MagicBlock ephemeral-vrf on devnet — a tiny `crate_roll` consumer program stores the verifiable random bytes; the client derives draws from them and feeds the existing pure crate math. Guests keep client RNG. Fail closed, refund local, never fake randomness.

**Architecture:** New standalone Anchor program `crate_roll` (request + identity-verified callback onto a per-player nonce'd `RollSlot` PDA) in the existing `onchain/raider` workspace — raider untouched. Client: a pure bytes→draws module, a poll-based crate-roll chain client behind an injectable io seam, an async `vrfDraws` path through `cratebox.doOpen` with hold/settle coin escrow (server spend forward deferred to fulfillment), wired in `main.ts` off the existing Privy session wallet.

**Tech Stack:** Anchor 0.32.1 (toolchain-pinned; local CLI is 0.31.1 — the `[toolchain]` block in Anchor.toml governs), `ephemeral-vrf-sdk = 0.3.0` (feature `anchor`), `@coral-xyz/anchor` client, Vitest, devnet.

**Spec:** `docs/superpowers/specs/2026-07-10-vrf-crates-design.md` (approved). Key constants: VRF program `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`, devnet queue via `ephemeral_vrf_sdk::consts::DEFAULT_QUEUE`, callback signer `ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY`.

**Out of scope (do not touch):** `programs/raider` (any file), the server (`server/`), real-money `$` prices, guest flow behavior, ER-hosted VRF.

---

## File Structure

**New**
- `onchain/raider/programs/crate-roll/Cargo.toml` + `src/lib.rs` — the consumer program.
- `onchain/raider/scripts/vrf-smoke.mjs` — devnet smoke: request → poll fulfilled (proves the oracle answers before any client work).
- `redline3d/src/chain/idl/crate-roll.json` + `crate-roll.ts` — IDL (copied from `target/idl`/`target/types` after build, same pattern as raider).
- `redline3d/src/core/vrf-draws.ts` + `.test.ts` — pure `[u8;32]` → uniform draws derivation.
- `redline3d/src/chain/crate-roll.ts` + `.test.ts` — request+poll client behind an injectable io seam.

**Modified**
- `onchain/raider/Anchor.toml` — `[programs.devnet] crate_roll = "<ID>"`.
- `redline3d/src/chain/config.ts` — `CRATE_ROLL_PROGRAM_ID`.
- `redline3d/src/ui/upgrades.ts` + `.test.ts` — `holdCoins`/`settleHold` escrow pair (quiet debit; commit fires the server forward, release restores quietly — never `coinsEarn`, which the earn cap would eat).
- `redline3d/src/ui/cratebox.ts` — async VRF open path + shake-loop + "⛓ MagicBlock VRF" reveal chip.
- `redline3d/src/chain/game-session.ts` — expose `anchorWallet()` (the connected port through `portToAnchorWallet`, or null).
- `redline3d/src/main.ts` — wire `vrfDraws` + hold/settle + toast into `createCrateBox`.

---

## Task 1: The `crate_roll` program

**Files:**
- Create: `onchain/raider/programs/crate-roll/Cargo.toml`
- Create: `onchain/raider/programs/crate-roll/src/lib.rs`

- [ ] **Step 1: Create `Cargo.toml`**

```toml
[package]
name = "crate-roll"
version = "0.1.0"
description = "MagicBlock VRF consumer for crate pulls: request + identity-verified callback storing 32 random bytes on a per-player nonce'd PDA. No funds, no roster, no odds."
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "crate_roll"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
ephemeral-vrf-sdk = { version = "0.3.0", features = ["anchor"] }
```

- [ ] **Step 2: Write `src/lib.rs`**

```rust
// crate_roll — the MagicBlock ephemeral-vrf consumer shim for crate pulls.
//
// Two instructions, one PDA. `request_roll` (player signs) CPIs the VRF program;
// MagicBlock's oracle computes + proves; the VRF program verifies the proof and CPIs
// `callback_fulfill_roll`, which may ONLY be invoked by the VRF program identity
// (enforced by the `address =` constraint on a required Signer). The randomness
// lands raw on the player's RollSlot; the CLIENT maps bytes -> car via the public
// deterministic crate math (provable by recomputation). No funds, no roster,
// no odds live here — blast radius of any bug is "crates fail to open".
use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

declare_id!("CRoLLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); // replaced by `anchor keys sync` in Task 2

pub const ROLL_SEED: &[u8] = b"roll";

#[program]
pub mod crate_roll {
    use super::*;

    /// Player requests randomness for one crate pull. Bumps the nonce (supersedes any
    /// stale in-flight request) and clears `fulfilled`; the caller_seed binds the VRF
    /// request to (player, nonce) so every pull's randomness is unique and attributable.
    pub fn request_roll(ctx: Context<RequestRoll>) -> Result<()> {
        let slot_acc = &mut ctx.accounts.roll_slot;
        slot_acc.player = ctx.accounts.payer.key();
        slot_acc.nonce = slot_acc.nonce.checked_add(1).expect("nonce overflow");
        slot_acc.fulfilled = false;
        slot_acc.bump = ctx.bumps.roll_slot;

        let seed = keccak::hashv(&[ctx.accounts.payer.key().as_ref(), &slot_acc.nonce.to_le_bytes()]).0;
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackFulfillRoll::DISCRIMINATOR.to_vec(),
            caller_seed: seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: slot_acc.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF-program-only callback: store the verified randomness. The `address =`
    /// constraint on the required signer means no wallet or other program can fake it.
    pub fn callback_fulfill_roll(ctx: Context<CallbackFulfillRoll>, randomness: [u8; 32]) -> Result<()> {
        let slot_acc = &mut ctx.accounts.roll_slot;
        slot_acc.randomness = randomness;
        slot_acc.fulfilled = true;
        slot_acc.slot = Clock::get()?.slot;
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = RollSlot::SIZE,
        seeds = [ROLL_SEED, payer.key().as_ref()],
        bump,
    )]
    pub roll_slot: Account<'info, RollSlot>,
    /// CHECK: MagicBlock oracle queue (devnet default), validated by address.
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CallbackFulfillRoll<'info> {
    /// The VRF program identity MUST sign — only MagicBlock's verified oracle path can fulfill.
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub roll_slot: Account<'info, RollSlot>,
}

/// One in-flight roll per player. A re-request supersedes (higher nonce, fulfilled=false);
/// the client only accepts randomness where `fulfilled && nonce == the one it requested`.
#[account]
pub struct RollSlot {
    pub player: Pubkey,
    pub nonce: u64,
    pub fulfilled: bool,
    pub randomness: [u8; 32],
    pub slot: u64,
    pub bump: u8,
}
impl RollSlot {
    // disc(8) + player(32) + nonce(8) + fulfilled(1) + randomness(32) + slot(8) + bump(1)
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 32 + 8 + 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roll_slot_size() {
        assert_eq!(RollSlot::SIZE, 90);
    }
    #[test]
    fn caller_seed_is_unique_per_nonce() {
        let p = Pubkey::new_unique();
        let s1 = keccak::hashv(&[p.as_ref(), &1u64.to_le_bytes()]).0;
        let s2 = keccak::hashv(&[p.as_ref(), &2u64.to_le_bytes()]).0;
        assert_ne!(s1, s2);
    }
}
```

- [ ] **Step 3: Cargo unit tests pass**

Run: `cd onchain/raider && cargo test -p crate-roll`
Expected: 2 passed. (If `DISCRIMINATOR` needs an import, add `use anchor_lang::Discriminator;`. If `invoke_signed_vrf` or a const path differs in sdk 0.3.0, match the compiler's suggestion — the sdk's README example is the source of truth; do NOT hand-roll the CPI.)

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/crate-roll
git commit -m "feat(onchain): crate_roll VRF consumer program" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Build, keys, deploy to devnet, IDL into the client

**Files:**
- Modify: `onchain/raider/Anchor.toml`, `onchain/raider/programs/crate-roll/src/lib.rs` (declare_id)
- Create: `redline3d/src/chain/idl/crate-roll.json`, `redline3d/src/chain/idl/crate-roll.ts`
- Modify: `redline3d/src/chain/config.ts`

- [ ] **Step 1: First build (generates the program keypair)**

Run: `cd onchain/raider && anchor build -p crate_roll`
Expected: `target/deploy/crate_roll-keypair.json` + `target/idl/crate_roll.json` exist. (The workspace `programs/*` glob already includes the new program; raider also rebuilds — that's fine, we deploy only crate_roll.)

- [ ] **Step 2: Sync the real program ID**

Run: `cd onchain/raider && anchor keys sync`
Expected: `declare_id!` in crate-roll's lib.rs and Anchor.toml's `[programs.devnet]` gain the real ID (verify Anchor.toml now has a `crate_roll = "..."` line; add it manually under `[programs.devnet]` if `keys sync` only patched lib.rs). Rebuild: `anchor build -p crate_roll` → exit 0.

- [ ] **Step 3: Deploy to devnet**

Run: `cd onchain/raider && anchor deploy -p crate_roll --provider.cluster devnet`
Expected: "Deploy success" with the program ID. (Wallet `~/.config/solana/lazer-probe.json` per Anchor.toml pays; if it lacks SOL: `solana airdrop 2 -k ~/.config/solana/lazer-probe.json -u devnet`.)

- [ ] **Step 4: Copy the IDL into the client (raider pattern)**

Run:
```bash
cp onchain/raider/target/idl/crate_roll.json redline3d/src/chain/idl/crate-roll.json
cp onchain/raider/target/types/crate_roll.ts redline3d/src/chain/idl/crate-roll.ts
```
Then in `redline3d/src/chain/config.ts`, add below `PROGRAM_ID`:
```ts
  // MagicBlock-VRF crate-pull consumer program (standalone; see docs/superpowers/specs/2026-07-10-vrf-crates-design.md)
  CRATE_ROLL_PROGRAM_ID: new PublicKey("<the deployed ID>"),
```
Run: `cd redline3d && npm run build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add onchain/raider/Anchor.toml onchain/raider/programs/crate-roll redline3d/src/chain/idl/crate-roll.json redline3d/src/chain/idl/crate-roll.ts redline3d/src/chain/config.ts
git commit -m "feat(onchain): deploy crate_roll to devnet + client IDL" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Devnet smoke — prove the oracle fulfills

**Files:**
- Create: `onchain/raider/scripts/vrf-smoke.mjs`

De-risk NOW, before any client work: if MagicBlock's devnet oracle doesn't answer, everything downstream changes.

- [ ] **Step 1: Write the smoke script**

```js
// vrf-smoke.mjs — request_roll with the dev wallet, then poll the RollSlot until the
// MagicBlock oracle fulfills. Proves the devnet VRF pipeline end-to-end in isolation.
// Run: node scripts/vrf-smoke.mjs
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const idl = JSON.parse(readFileSync(new URL("../target/idl/crate_roll.json", import.meta.url), "utf8"));
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${homedir()}/.config/solana/lazer-probe.json`, "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const wallet = new anchor.Wallet(kp);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [rollSlot] = PublicKey.findProgramAddressSync([Buffer.from("roll"), kp.publicKey.toBuffer()], program.programId);
const before = await program.account.rollSlot.fetchNullable(rollSlot);
const expect = (before ? Number(before.nonce) : 0) + 1;

console.log("requesting roll (expect nonce", expect, ")…");
const sig = await program.methods.requestRoll().accounts({ payer: kp.publicKey }).rpc();
console.log("request tx:", sig);

const t0 = Date.now();
for (;;) {
  const s = await program.account.rollSlot.fetch(rollSlot);
  if (s.fulfilled && Number(s.nonce) === expect) {
    console.log(`FULFILLED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log("randomness:", Buffer.from(s.randomness).toString("hex"));
    process.exit(0);
  }
  if (Date.now() - t0 > 30_000) { console.error("TIMEOUT: no fulfillment in 30s"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
```

- [ ] **Step 2: Run it**

Run: `cd onchain/raider && node scripts/vrf-smoke.mjs`
Expected: `FULFILLED in ~2-8s` + 64 hex chars of randomness. Run it TWICE — the second run proves the nonce supersede (expect nonce 2). If accounts resolution complains (anchor account name casing / missing oracle_queue), pass accounts explicitly: `.accounts({ payer, rollSlot, oracleQueue: new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"), systemProgram: SystemProgram.programId })` — but prefer the resolved form. If it times out repeatedly, STOP: report BLOCKED (oracle availability), do not proceed to client work.

- [ ] **Step 3: Forged-callback rejection (the core security property, proven on devnet)**

Append to the end of `vrf-smoke.mjs` (before the final poll loop exits, or as a second script section that runs after fulfillment):
```js
// A forged fulfillment MUST fail: callback_fulfill_roll requires the VRF program identity
// as signer; the dev wallet is not it, so this call must be rejected by the address constraint.
try {
  await program.methods.callbackFulfillRoll(Array.from({ length: 32 }, () => 7))
    .accounts({ vrfProgramIdentity: kp.publicKey, rollSlot })
    .rpc();
  console.error("SECURITY FAIL: forged callback was ACCEPTED");
  process.exit(1);
} catch {
  console.log("forged callback rejected (address constraint holds)");
}
```
Run: `cd onchain/raider && node scripts/vrf-smoke.mjs`
Expected: `FULFILLED in ~…s` AND `forged callback rejected`. (The forged call fails at the anchor constraint — any error is a pass here; acceptance is the failure.)

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/scripts/vrf-smoke.mjs
git commit -m "test(onchain): devnet VRF fulfillment + forged-callback smoke for crate_roll" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Pure bytes→draws derivation

**Files:**
- Create: `redline3d/src/core/vrf-draws.ts`, `redline3d/src/core/vrf-draws.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { bytesToDraws } from "./vrf-draws";

describe("bytesToDraws", () => {
  it("maps 8-byte BE chunks to uniform [0,1) draws", () => {
    const bytes = new Uint8Array(32);
    // chunk 0 = 0x0000000000000000 -> 0
    // chunk 1 = 0x8000000000000000 -> 0.5
    bytes[8] = 0x80;
    // chunk 2 = 0xFFFFFFFFFFFFFFFF -> just under 1
    for (let i = 16; i < 24; i++) bytes[i] = 0xff;
    // chunk 3 = 0x4000000000000000 -> 0.25
    bytes[24] = 0x40;
    const d = bytesToDraws(bytes, 4);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0.5);
    expect(d[2]).toBeLessThan(1);
    expect(d[2]).toBeGreaterThan(0.9999999999);
    expect(d[3]).toBe(0.25);
  });
  it("throws if more draws are requested than the bytes hold", () => {
    expect(() => bytesToDraws(new Uint8Array(32), 5)).toThrow();
  });
});
```

Run: `cd redline3d && npx vitest run src/core/vrf-draws.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
// vrf-draws.ts — the FIXED public derivation from on-chain VRF randomness to uniform draws.
// [u8;32] -> up to 4 draws in [0,1): consecutive 8-byte chunks read as big-endian u64 / 2^64.
// This mapping + the pure crate math (crate.ts) is what makes a pull provable by recomputation:
// anyone can take the on-chain bytes and re-derive the exact car/scrap/level outcome.
export function bytesToDraws(bytes: Uint8Array, n: number): number[] {
  if (n * 8 > bytes.length) throw new Error(`need ${n * 8} bytes, have ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  // top-53-bit reduction: Number(u64)/2**64 would round 2^64-1 UP to exactly 1.0 (doubles have a
  // 53-bit mantissa), violating the [0,1) contract; >>11 keeps the mapping exact and strictly <1.
  for (let i = 0; i < n; i++) out.push(Number(dv.getBigUint64(i * 8, false) >> 11n) / 2 ** 53);
  return out;
}
```

- [ ] **Step 3: Green + commit**

Run: `cd redline3d && npx vitest run src/core/vrf-draws.test.ts` → 2 passed.
```bash
git add redline3d/src/core/vrf-draws.ts redline3d/src/core/vrf-draws.test.ts
git commit -m "feat(client): VRF bytes->draws public derivation" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Coin escrow — `holdCoins`/`settleHold` on upgrades

**Files:**
- Modify: `redline3d/src/ui/upgrades.ts`, `redline3d/src/ui/upgrades.test.ts`

**Why:** the VRF path must debit BEFORE the request (no peek-then-buy) but forward the server spend only on fulfillment; a failed pull restores locally with ZERO server traffic (a `coinsEarn`-style refund would be eaten by the earn cap). The existing `spend()` fires its server forward immediately — wrong shape for this.

- [ ] **Step 1: Failing tests (append to `upgrades.test.ts`, matching its existing style)**

```ts
it("holdCoins debits quietly (no onMutate) and settleHold(commit) fires exactly one coinsSpend", () => {
  // arrange: upgrades with coins seeded (use the file's existing harness idiom), events captured via onMutate
  expect(u.holdCoins(250)).toBe(true);
  expect(u.coins()).toBe(startingCoins - 250);
  expect(events).toEqual([]); // hold is silent
  u.settleHold(250, true);
  expect(events).toEqual([{ kind: "coinsSpend", amount: 250 }]);
});
it("settleHold(release) restores quietly — no events at all", () => {
  u.holdCoins(250);
  u.settleHold(250, false);
  expect(u.coins()).toBe(startingCoins);
  expect(events).toEqual([]);
});
it("holdCoins refuses over-balance and stays silent", () => {
  expect(u.holdCoins(startingCoins + 1)).toBe(false);
  expect(u.coins()).toBe(startingCoins);
  expect(events).toEqual([]);
});
```
(Reconcile the harness names — `u`, `events`, `startingCoins` — with the file's existing tests; do not invent new helpers.)
Run: `cd redline3d && npx vitest run src/ui/upgrades.test.ts` → the 3 new tests FAIL (no such methods).

- [ ] **Step 2: Implement (in `createUpgrades`'s returned object + the `Upgrades` interface)**

```ts
  /** Quiet escrow debit for an async purchase (VRF crate): debits + persists + updates the HUD but
   *  fires NO onMutate — the server forward is deferred to settleHold. false if it can't cover n. */
  holdCoins(n: number): boolean;
  /** Settle a prior hold: commit=true forwards the spend to the server (one coinsSpend); commit=false
   *  restores the coins quietly (no events — a coinsEarn refund would be eaten by the earn cap). */
  settleHold(n: number, commit: boolean): void;
```
```ts
    holdCoins(n) {
      const amt = Math.floor(n);
      if (saved.coins < amt) return false;
      saved.coins -= amt;
      persist(); opts.onCoins?.(saved.coins);
      return true;
    },
    settleHold(n, commit) {
      const amt = Math.floor(n);
      if (commit) { opts.onMutate?.({ kind: "coinsSpend", amount: amt }); return; }
      saved.coins += amt;
      persist(); opts.onCoins?.(saved.coins);
    },
```

- [ ] **Step 3: Green + full suite + commit**

Run: `cd redline3d && npx vitest run src/ui/upgrades.test.ts` → all green (existing + 3).
```bash
git add redline3d/src/ui/upgrades.ts redline3d/src/ui/upgrades.test.ts
git commit -m "feat(client): quiet hold/settle coin escrow for async purchases" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Chain client — request + poll behind an injectable io seam

**Files:**
- Create: `redline3d/src/chain/crate-roll.ts`, `redline3d/src/chain/crate-roll.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { createCrateRollDraws } from "./crate-roll";

const slot = (nonce: number, fulfilled: boolean, fill = 0x80) =>
  ({ nonce, fulfilled, randomness: new Uint8Array(32).fill(fill) });

describe("createCrateRollDraws", () => {
  it("requests, polls until the matching nonce fulfills, returns derived draws", async () => {
    const states = [slot(1, false), slot(2, false), slot(2, true)]; // pre-state nonce 1 → expect 2
    const io = {
      fetchSlot: vi.fn(async () => states.shift() ?? slot(2, true)),
      request: vi.fn(async () => {}),
      sleep: async () => {},
    };
    const draws = await createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4);
    expect(io.request).toHaveBeenCalledOnce();
    expect(draws).toHaveLength(4);
    expect(draws[0]).toBeCloseTo(0x8080808080808080 / 2 ** 64, 10);
  });
  it("ignores a stale fulfillment (nonce below the requested one)", async () => {
    const states = [slot(1, false), slot(1, true, 0x11), slot(2, true, 0x22)]; // pre-state nonce 1
    const io = { fetchSlot: vi.fn(async () => states.shift() ?? slot(2, true, 0x22)), request: async () => {}, sleep: async () => {} };
    const draws = await createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4);
    expect(draws[0]).toBeCloseTo(0x2222222222222222 / 2 ** 64, 10); // waited for nonce 2, not stale 1
  });
  it("times out and throws vrf_timeout", async () => {
    const io = { fetchSlot: async () => slot(1, false), request: async () => {}, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 6000); })() };
    await expect(createCrateRollDraws(io, { timeoutMs: 10_000, pollMs: 1 })(4)).rejects.toThrow("vrf_timeout");
  });
});
```
Run: `cd redline3d && npx vitest run src/chain/crate-roll.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// crate-roll.ts — client for the crate_roll VRF consumer program: send request_roll with the
// session wallet, then poll the RollSlot PDA until MagicBlock's oracle fulfills OUR nonce.
// Pure orchestration is factored behind CrateRollIo so the poll/nonce/timeout logic is unit-testable;
// makeCrateRollIo binds the real anchor program (mirrors chain-round.ts's provider pattern).
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { CHAIN } from "./config";
import type { AnchorWalletLike } from "./anchor-wallet";
import { bytesToDraws } from "../core/vrf-draws";
import idl from "./idl/crate-roll.json";

export interface RollSlotState { nonce: number; fulfilled: boolean; randomness: Uint8Array; }
export interface CrateRollIo {
  /** current on-chain slot state, or null if the PDA doesn't exist yet */
  fetchSlot(): Promise<RollSlotState | null>;
  /** send + confirm the request_roll tx (signed by the session wallet) */
  request(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

/** Returns a draws(n) function: one VRF request per call, resolved to n uniform [0,1) draws. */
export function createCrateRollDraws(io: CrateRollIo, opts: { timeoutMs?: number; pollMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000, pollMs = opts.pollMs ?? 500;
  const now = io.now ?? Date.now;
  return async (n: number): Promise<number[]> => {
    const before = await io.fetchSlot();
    const expect = (before?.nonce ?? 0) + 1;
    await io.request();
    const t0 = now();
    for (;;) {
      const s = await io.fetchSlot();
      // only OUR request satisfies: a stale fulfillment (lower nonce) is ignored; a HIGHER nonce
      // means something superseded us mid-flight (shouldn't happen single-client) — keep waiting
      // until timeout rather than consume randomness we didn't request.
      if (s && s.fulfilled && s.nonce === expect) return bytesToDraws(s.randomness, n);
      if (now() - t0 > timeoutMs) throw new Error("vrf_timeout");
      await io.sleep(pollMs);
    }
  };
}

/** Real io against devnet via the session's anchor wallet. */
export function makeCrateRollIo(wallet: AnchorWalletLike): CrateRollIo {
  const conn = new Connection(CHAIN.BASE_RPC, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(conn, wallet as anchor.Wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  const [rollSlot] = PublicKey.findProgramAddressSync([Buffer.from("roll"), wallet.publicKey.toBuffer()], CHAIN.CRATE_ROLL_PROGRAM_ID);
  return {
    async fetchSlot() {
      const s: any = await (program.account as any).rollSlot.fetchNullable(rollSlot);
      return s ? { nonce: Number(s.nonce), fulfilled: !!s.fulfilled, randomness: new Uint8Array(s.randomness) } : null;
    },
    async request() {
      await (program.methods as any).requestRoll().accounts({ payer: wallet.publicKey }).rpc();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
```
(If the anchor account resolver can't infer `rollSlot`/`oracleQueue`, pass them explicitly in `.accounts({...})` exactly as the smoke script's fallback does — reuse what Task 3 proved.)

- [ ] **Step 3: Green + commit**

Run: `cd redline3d && npx vitest run src/chain/crate-roll.test.ts` → 3 passed. `npm run build` → exit 0.
```bash
git add redline3d/src/chain/crate-roll.ts redline3d/src/chain/crate-roll.test.ts
git commit -m "feat(client): crate-roll VRF request+poll chain client" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: cratebox — the async VRF open path

**Files:**
- Modify: `redline3d/src/ui/cratebox.ts`

**Current flow (lines 270–302):** `doOpen` rolls sync draws up front (`rollCrate(..., rng.next(), rng.next())` BEFORE `deps.spend`), resolves grants, then plays a cosmetic 500ms shake → reveal. The VRF path inverts payment/randomness order by design and awaits the oracle during the shake.

- [ ] **Step 1: Extend deps + interface**

```ts
  /** signed-in VRF draws: () => null (guest / not connected) | draws(n) that resolves n uniform
   *  draws from MagicBlock VRF. Resolved PER OPEN so a mid-session sign-in upgrades the path. */
  vrfDraws?: () => (null | ((n: number) => Promise<number[]>));
  /** quiet escrow for the VRF path (upgrades.holdCoins/settleHold) */
  holdCoins?: (n: number) => boolean;
  settleHold?: (n: number, commit: boolean) => void;
  /** surface a VRF failure to the player (toast) */
  onVrfFail?: (msg: string) => void;
```

- [ ] **Step 2: Shake-loop CSS + VRF chip CSS (append inside `injectStyles`)**

```css
    .cb-crate3d.shakeloop,.cb-crate.shakeloop{animation:cbShake .5s cubic-bezier(.36,.07,.19,.97) infinite}
    .cb-vrf{display:inline-flex;align-items:center;gap:5px;margin-top:7px;padding:4px 9px;border-radius:6px;
      font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;color:#a7f0d9;
      background:rgba(20,199,140,.12);border:1px solid rgba(20,199,140,.4)}
```

- [ ] **Step 3: Rework `doOpen` — async, both paths**

Replace the current `doOpen` with (preserving every existing behavior on the guest path):

```ts
  const showCrateAnim = (crate: CrateType, loop: boolean) => {
    rows.style.display = "none";
    btns.style.display = "none"; btns.innerHTML = "";
    stage.innerHTML = (cratePng[crate.key]
      ? `<img class="cb-crate3d ${loop ? "shakeloop" : "shake"}" src="${cratePng[crate.key]}" style="--cc:${crate.color}">`
      : `<div class="cb-crate ${loop ? "shakeloop" : "shake"}" style="--cc:${crate.color}"></div>`) + `<div class="cb-flash"></div>`;
    stage.classList.add("on");
  };
  const burstToReveal = (crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null, vrf: boolean) => {
    const crateEl = stage.querySelector(".cb-crate3d, .cb-crate") as HTMLElement;
    const flash = stage.querySelector(".cb-flash") as HTMLElement;
    if (tierOf(car.rarity).id >= 4) flash.style.transform = "scale(1.5)";
    crateEl.classList.remove("shake", "shakeloop"); crateEl.classList.add("gone");
    flash.classList.add("go");
    window.setTimeout(() => showReveal(crate, car, isNew, scrap, lvlKey, vrf), 230);
  };
  const resolveAndReveal = (crate: CrateType, draws: number[], vrf: boolean): boolean => {
    const car = rollCrate(deps.cars(), crate.tierWeights, draws[0], draws[1]);
    if (!car) return false; // nothing droppable
    const isNew = deps.grantCar(car.name);
    let scrap = crate.scrap;
    if (isNew) deps.unlockUI(car.name);
    else scrap += dupeScrap(car.rarity);
    deps.addScrap(scrap);
    const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]);
    if (lvlKey) deps.grantLevel(lvlKey);
    burstToReveal(crate, car, isNew, scrap, lvlKey, vrf);
    return true;
  };

  const doOpen = (crate: CrateType, free = false) => {
    if (opening) return;
    if (!free) giftMode = false;
    const vrfProvider = deps.vrfDraws?.() ?? null;

    if (!vrfProvider) {
      // ── guest / not connected: the existing sync client-RNG path, verbatim behavior ──
      if (!free && deps.coins() < crate.priceCoins) { syncCoins(); return; }
      const draws = [rng.next(), rng.next(), rng.next(), rng.next()];
      const car = rollCrate(deps.cars(), crate.tierWeights, draws[0], draws[1]);
      if (!car) { if (free) { giftMode = false; close(); } return; }
      if (!free && !deps.spend(crate.priceCoins)) return;
      opening = true;
      syncCoins();
      showCrateAnim(crate, false);
      window.setTimeout(() => {
        // re-resolve grants exactly as before (sync draws already fixed the outcome)
        const isNew = deps.grantCar(car.name);
        let scrap = crate.scrap;
        if (isNew) deps.unlockUI(car.name); else scrap += dupeScrap(car.rarity);
        deps.addScrap(scrap);
        const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]);
        if (lvlKey) deps.grantLevel(lvlKey);
        burstToReveal(crate, car, isNew, scrap, lvlKey, false);
      }, 500);
      return;
    }

    // ── signed-in: MagicBlock VRF. Debit FIRST (the mapping is public — randomness must never
    // be knowable before payment), request, shake while the oracle answers, fail closed. ──
    if (!free) {
      if (!deps.holdCoins || !deps.settleHold) { deps.onVrfFail?.("VRF wiring missing"); return; }
      if (!deps.holdCoins(crate.priceCoins)) { syncCoins(); return; }
    }
    opening = true;
    syncCoins();
    showCrateAnim(crate, true); // loop the shake while the oracle works
    void vrfProvider(4).then((draws) => {
      if (!free) deps.settleHold!(crate.priceCoins, true); // commit: forward the spend to the server
      if (!resolveAndReveal(crate, draws, true)) { opening = false; if (giftMode) { giftMode = false; close(); } else showShop(); }
    }).catch(() => {
      if (!free) deps.settleHold!(crate.priceCoins, false); // release: quiet local restore, zero server traffic
      opening = false;
      deps.onVrfFail?.("Couldn't reach the randomness oracle — try again.");
      if (giftMode) { giftMode = false; close(); } else showShop();
    });
  };
```

- [ ] **Step 4: The VRF chip in `showReveal`**

Change the signature to `showReveal(crate, car, isNew, scrap, lvlKey, vrf: boolean)` and append inside the `cb-plate` div HTML:
```ts
        (vrf ? `<span class="cb-vrf">⛓ MagicBlock VRF</span>` : "") +
```
Fix the one other caller if any (search `showReveal(`).

- [ ] **Step 5: Type-check + full client suite**

Run: `cd redline3d && npm run build` → exit 0. `npx vitest run` → all green. (Check for existing cratebox tests first — `ls redline3d/src/ui/cratebox*.test.ts` — and keep any green; if none exist, do NOT add DOM tests here: the roll math is covered by crate.ts tests and the VRF client by Task 6, and the reveal/anim is DOM-cosmetic.)

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/ui/cratebox.ts
git commit -m "feat(client): async MagicBlock-VRF crate open path (fail closed)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Wire it in `main.ts` + expose the session wallet

**Files:**
- Modify: `redline3d/src/chain/game-session.ts`, `redline3d/src/main.ts`

- [ ] **Step 1: `game-session.ts` — expose the connected anchor wallet**

The session owns the wallet `port` internally (it builds `createChainRound({ wallet: portToAnchorWallet(port!) … })` around line 146). Add to the session's RETURNED object (near `address()`), and to its interface:
```ts
  /** the connected session wallet as an anchor wallet, or null before connect — lets other
   *  chain clients (crate_roll VRF) sign with the SAME wallet the round loop uses. */
  anchorWallet(): AnchorWalletLike | null;
```
```ts
    anchorWallet: () => { try { return port?.currentAddress() ? portToAnchorWallet(port) : null; } catch { return null; } },
```
(`portToAnchorWallet` is already imported at game-session.ts:4; import the `AnchorWalletLike` type. Match the exact local variable holding the port — read the file first.)

- [ ] **Step 2: `main.ts` — wire the crateBox deps**

In the `createCrateBox(hudRoot, {...})` block (~line 523), add:
```ts
  // MagicBlock VRF (signed-in only): one randomness request per pull, signed by the same
  // session wallet as rounds. Guests fall through to client RNG (practice parity).
  vrfDraws: () => {
    if (!identity || identity.mode !== "account") return null;
    const w = session.anchorWallet();
    if (!w) return null;
    return createCrateRollDraws(makeCrateRollIo(w));
  },
  holdCoins: (n) => upgrades.holdCoins(n),
  settleHold: (n, commit) => upgrades.settleHold(n, commit),
  onVrfFail: (msg) => lobbyHud.toast(msg),
```
With imports: `import { createCrateRollDraws, makeCrateRollIo } from "./chain/crate-roll";`
(Verify `identity.mode === "account"` is the signed-in discriminator by reading the identity block — the gate code at ~line 1694 references account vs guest; match the real field. Note: `lobbyHud.toast` is the existing toast seam — see the `onBuyUsd` line right above.)

- [ ] **Step 3: Gates**

Run: `cd redline3d && npm run build` → exit 0. `npx vitest run` → all green.

- [ ] **Step 4: Commit**

```bash
git add redline3d/src/chain/game-session.ts redline3d/src/main.ts
git commit -m "feat(client): wire MagicBlock VRF draws into the crate shop" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Final verification (live)

- [ ] `cd onchain/raider && cargo test -p crate-roll` → green.
- [ ] `cd redline3d && npm run build && npx vitest run` → all green.
- [ ] `node onchain/raider/scripts/vrf-smoke.mjs` → FULFILLED (oracle still answering).
- [ ] **Live browser pull (the done-gate):** run the dev client, sign in (Privy devnet), open Crates, buy a Wooden crate → observe: coins debit immediately, crate shake-loops a few seconds, reveal shows the car + "⛓ MagicBlock VRF" chip, zero console errors. Then as a GUEST: buy a crate → instant open, no chip, no chain traffic (network tab clean of devnet RPC).
- [ ] **Provability spot-check:** from the browser session, note the player pubkey; `solana account <rollSlot PDA> -u devnet` (or the smoke script's fetch) shows the same randomness bytes; re-derive the 4 draws with `bytesToDraws` and confirm `rollCrate` reproduces the revealed car.

## What this deliberately leaves out
- Server awareness of VRF pulls (grants still flow through the existing client→server sync; authority is the Phase 2 co-sign track).
- ER-hosted (gasless) VRF, real-money prices, on-chain odds.
