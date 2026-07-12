# Phase 1 — Core On-Chain Round (Perps Rider) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On devnet, prove the full non-custodial money + settlement loop for Perps Rider — buy-in → delegate to the MagicBlock ER → open/close a round settled against on-chain Pyth Lazer → undelegate → owner-only withdraw — with a real SPL token and a TypeScript driver.

**Architecture:** A new Anchor program `raider` holds real USDC in a program-owned vault (L1) and tracks play balances in two delegatable u64 ledgers — per-player `PlayerBalance` and a shared `HouseBalance`. A round opens/closes inside the ER, reading the live Lazer BTC price and moving value between the ledgers via a fixed-point port of `@perps/engine`. The house pre-locks each round's maximum payout at open, so it is provably solvent. Only the owner's wallet can withdraw.

**Tech Stack:** Anchor 0.32.1 (build with `~/.avm/bin/anchor-0.32.1`), `ephemeral-rollups-sdk` 0.15.5 (feature `anchor-compat`), `@coral-xyz/anchor` + `@solana/web3.js` + `@solana/spl-token` (TS driver), ts-mocha. Reuses the Phase-0 spike toolchain and the `parse_price_update` decoder verbatim.

**Spec:** `docs/superpowers/specs/2026-06-27-phase1-onchain-round-design.md`
**Reference code:** `spikes/lazer-probe/programs/lazer-probe/src/lib.rs` (delegation/commit pattern + Lazer decoder), `spikes/lazer-probe/tests/lazer-probe.ts` (driver pattern, two providers), `packages/engine/src/economics.ts` + `config.ts` (the settle math being ported).

**Funding:** Reuse the devnet keypair `~/.config/solana/lazer-probe.json` (or a fresh `raider.json`), funded from `~/.config/solana/flash-v2-devnet.json` (the faucet is rate-limited — transfer, don't airdrop). Program deploy needs ~3–5 devnet SOL on hand.

**Known carry-forwards from Phase 0 (do not relearn these):**
- Build with `~/.avm/bin/anchor-0.32.1 build`; the standalone `anchor` at `~/.cargo/bin` is 0.31.1 and shadows avm. Delete any stale `Cargo.lock` if `anchor-compat` breaks.
- `pyth-solana-receiver-sdk` conflicts with ers-sdk on `bytemuck_derive` — do NOT add it. Hand-decode the price account (`price.rs`).
- Lazer-on-ER exponent is a **positive magnitude**: USD = `price · 10^(−expo)`.
- Both `https://devnet.magicblock.app` and `devnet-as.magicblock.app` report validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`; BTC feed `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr`.

---

## Task 1: Anchor workspace scaffold + dependency trio compiles

**Files:**
- Create: `onchain/raider/Anchor.toml`
- Create: `onchain/raider/Cargo.toml`
- Create: `onchain/raider/programs/raider/Cargo.toml`
- Create: `onchain/raider/programs/raider/src/lib.rs` (skeleton)
- Create: `onchain/raider/package.json`, `onchain/raider/tsconfig.json`

- [ ] **Step 1: Scaffold the workspace by copying the proven spike layout**

```bash
mkdir -p onchain/raider/programs/raider/src onchain/raider/tests
cp spikes/lazer-probe/Cargo.toml onchain/raider/Cargo.toml
cp spikes/lazer-probe/package.json onchain/raider/package.json
cp spikes/lazer-probe/tsconfig.json onchain/raider/tsconfig.json
cp spikes/lazer-probe/programs/lazer-probe/Cargo.toml onchain/raider/programs/raider/Cargo.toml
```

- [ ] **Step 2: Rename the program to `raider` in the two Cargo.toml files**

In `onchain/raider/programs/raider/Cargo.toml` set `name = "raider"`, `[lib] name = "raider"`. Keep the winning deps verbatim:

```toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
anchor-spl = "0.32.1"
ephemeral-rollups-sdk = { version = "0.15.5", features = ["anchor"] }
```

(`anchor-spl` is added vs the spike — Phase 1 moves real SPL tokens. Verify it resolves alongside ers-sdk; if `anchor-compat`/feature naming differs from the spike's, match whatever string the spike's `Cargo.toml` actually used for ers-sdk.)

- [ ] **Step 3: Write `Anchor.toml` pointing at devnet with a placeholder program id**

```toml
[toolchain]
anchor_version = "0.32.1"
package_manager = "yarn"

[features]
resolution = true
skip-lint = false

[programs.devnet]
raider = "Raider11111111111111111111111111111111111111"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/lazer-probe.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

- [ ] **Step 4: Write a minimal compiling `lib.rs` skeleton**

```rust
use anchor_lang::prelude::*;

declare_id!("Raider11111111111111111111111111111111111111");

#[ephemeral_rollups_sdk::anchor::ephemeral]
#[program]
pub mod raider {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Ping<'info> { pub payer: Signer<'info> }
```

- [ ] **Step 5: Build and verify the trio compiles**

Run: `cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build`
Expected: builds clean; `target/idl/raider.json` and `target/deploy/raider-keypair.json` produced. If `bytemuck_derive`/`anchor-compat` errors appear, delete `onchain/raider/Cargo.lock` and rebuild (Phase-0 fix).

- [ ] **Step 6: Sync the real program id**

```bash
cd onchain/raider
PROG=$(solana address -k target/deploy/raider-keypair.json)
echo "program id: $PROG"
# replace the placeholder in Anchor.toml [programs.devnet] and declare_id! in lib.rs, then rebuild
~/.avm/bin/anchor-0.32.1 build
```

- [ ] **Step 7: Commit**

```bash
git add onchain/raider
git commit -m "feat(raider): scaffold phase-1 anchor workspace + dependency trio compiles"
```

---

## Task 2 (FRONT-LOADED RISK): Two-account co-delegation round-trips through the ER

Prove the make-or-break Phase-1 assumption early: **two independently-owned PDAs can be co-delegated to the same ER, mutated together in one in-rollup instruction, and committed/undelegated atomically.** Everything downstream (player⇄house value movement) depends on this. Use two throwaway counter PDAs; delete them once proven.

**Files:**
- Modify: `onchain/raider/programs/raider/src/lib.rs`
- Create: `onchain/raider/tests/codeleg.ts`

- [ ] **Step 1: Add two counter PDAs + init/delegate/bump/commit instructions**

Mirror the spike's `delegate`/`commit_and_undelegate` exactly (`delegate_pda` with `DelegateConfig { validator }`, `MagicIntentBundleBuilder::new(...).commit_and_undelegate(&[a, b]).build_and_invoke()`). Define `CounterA`/`CounterB` PDAs (seeds `[b"a"]`, `[b"b"]`, each `{ value: u64 }`); a `bump_both` instruction that increments A and decrements B in one call (both `#[account(mut)]`, both delegated).

- [ ] **Step 2: Write the failing driver test**

```ts
// onchain/raider/tests/codeleg.ts — init both, delegate both to the ER, call bump_both on the ER, commit+undelegate, assert A increased and B decreased on L1.
```
Model it on `spikes/lazer-probe/tests/lazer-probe.ts` (two providers: base devnet + `https://devnet.magicblock.app`; `commit_and_undelegate` with a 60s undelegate poll). Pass `[VALIDATOR]` as a remaining account on delegate.

- [ ] **Step 3: Build, deploy, run**

```bash
cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && anchor deploy --provider.cluster devnet
ANCHOR_WALLET=~/.config/solana/lazer-probe.json npx ts-mocha -p ./tsconfig.json -t 1000000 tests/codeleg.ts
```
Expected: both PDAs delegate (owner → `DELeGG…`), `bump_both` runs in the ER, commit/undelegate lands both updated values on L1. **If co-delegation of two PDAs fails or commit isn't atomic, STOP and escalate — the house/player topology depends on it.**

- [ ] **Step 4: Remove the throwaway counters, keep the proven delegation/commit plumbing pattern documented in a code comment, commit**

```bash
git add onchain/raider && git commit -m "test(raider): prove two-account co-delegation + atomic commit on devnet ER"
```

---

## Task 3: Fixed-point settlement module (`settle.rs`) with unit tests

Pure integer math, no f64. This is the provable-fairness core. TDD against vectors from `@perps/engine`.

**Files:**
- Create: `onchain/raider/programs/raider/src/settle.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs` (add `mod settle;`)

- [ ] **Step 1: Write the module with constants + functions**

```rust
// settle.rs — fixed-point port of packages/engine/src/economics.ts (no actions: banked = 0).
pub const SCALE: i128 = 1_000_000;
pub const EDGE_FP: i128 = 50_000;        // 0.05
pub const LIQ_FP: i128 = 200_000;        // 0.20
pub const CAP_FP: i128 = 25_000_000;     // 25.0
pub const RMIN: u32 = 10;
pub const RMAX: u32 = 2000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Outcome { Cashout, Cap, Liq }

/// equity_fp = SCALE + dir*lev*(exit/entry - 1), clamped >= 0. Same feed => expo cancels.
pub fn equity_fp(dir: i8, lev: u32, entry_raw: i64, exit_raw: i64) -> i128 {
    let ratio = (exit_raw as i128) * SCALE / (entry_raw as i128);
    let eq = SCALE + (dir as i128) * (lev as i128) * (ratio - SCALE);
    if eq < 0 { 0 } else { eq }
}

/// Apply terminal precedence at the exit mark; return (outcome, settled_equity_fp).
pub fn terminal(eq: i128) -> (Outcome, i128) {
    if eq <= LIQ_FP { (Outcome::Liq, 0) }
    else if eq >= CAP_FP { (Outcome::Cap, CAP_FP) }
    else { (Outcome::Cashout, eq) }
}

/// payout = floor(stake * equity * (1 - edge)); u128 intermediates.
pub fn payout(stake: u64, settled_eq_fp: i128) -> u64 {
    let p = (stake as u128) * (settled_eq_fp as u128) * ((SCALE - EDGE_FP) as u128)
        / (SCALE as u128) / (SCALE as u128);
    p as u64
}

/// Max a round can ever pay (equity capped at CAP): the house pre-lock at open.
pub fn max_payout(stake: u64) -> u64 { payout(stake, CAP_FP) }

/// Full settle for one mark.
pub fn settle(dir: i8, lev: u32, stake: u64, entry_raw: i64, exit_raw: i64) -> (Outcome, u64) {
    let (o, eq) = terminal(equity_fp(dir, lev, entry_raw, exit_raw));
    (o, payout(stake, eq))
}
```

- [ ] **Step 2: Write failing unit tests (vectors hand-computed from the TS engine)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // long, 100x, entry 60000, exit 60600 (+1%): equity = 1 + 100*0.01 = 2.0 => 2_000_000
    #[test] fn long_winner() {
        let (o, p) = settle(1, 100, 1_000_000, 60_000, 60_600);
        assert_eq!(o, Outcome::Cashout);
        // 1_000_000 * 2_000_000 * 950_000 / 1e12 = 1_900_000
        assert_eq!(p, 1_900_000);
    }
    // long, 1000x, exit -0.1% => equity = 1 + 1000*(-0.001) = 0 => liq
    #[test] fn long_liquidated() {
        let (o, p) = settle(1, 1000, 1_000_000, 60_000, 59_940);
        assert_eq!(o, Outcome::Liq);
        assert_eq!(p, 0);
    }
    // short, 50x, exit -2% => equity = 1 + 50*0.02 = 2.0
    #[test] fn short_winner() {
        let (o, _) = settle(-1, 50, 1_000_000, 60_000, 58_800);
        assert_eq!(o, Outcome::Cashout);
    }
    // cap clamp: equity would exceed 25 => Cap, payout = stake*25*0.95
    #[test] fn cap_clamp() {
        let (o, p) = settle(1, 2000, 1_000_000, 60_000, 60_900); // +1.5% * 2000 = +30 => >25
        assert_eq!(o, Outcome::Cap);
        assert_eq!(p, max_payout(1_000_000)); // 23_750_000
    }
    #[test] fn max_payout_is_23_75x() { assert_eq!(max_payout(1_000_000), 23_750_000); }
}
```

- [ ] **Step 3: Run, verify pass**

Run: `cd onchain/raider/programs/raider && cargo test`
Expected: 5/5 pass. (`cargo test` runs the pure module without the BPF/anchor entrypoint.) If the engine's exact floor differs on a vector, fix the *test vector* to what the integer math produces and note the rounding direction (house-favorable floor).

- [ ] **Step 4: Commit**

```bash
git add onchain/raider/programs/raider/src/settle.rs onchain/raider/programs/raider/src/lib.rs
git commit -m "feat(raider): fixed-point settlement port of @perps/engine + unit tests"
```

---

## Task 4: State module + price decoder + `init_house`

**Files:**
- Create: `onchain/raider/programs/raider/src/state.rs`
- Create: `onchain/raider/programs/raider/src/price.rs`
- Modify: `onchain/raider/programs/raider/src/lib.rs`

- [ ] **Step 1: Write `state.rs` (accounts + constants)**

```rust
use anchor_lang::prelude::*;

pub const MAX_ROUND_SECS: i64 = 300;  // liveness backstop, NOT the game time-cap (Phase 2)
pub const STALE_SECS: i64 = 30;       // reject settle against prices older than this

#[account]
pub struct PlayerBalance { pub owner: Pubkey, pub mint: Pubkey, pub balance: u64, pub bump: u8 }
impl PlayerBalance { pub const SIZE: usize = 8 + 32 + 32 + 8 + 1; }

#[account]
pub struct HouseBalance { pub authority: Pubkey, pub mint: Pubkey, pub balance: u64, pub locked: u64, pub bump: u8 }
impl HouseBalance { pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1; }

// status: 0 idle, 1 open, 2 settled
#[account]
pub struct Round {
    pub owner: Pubkey, pub dir: i8, pub lev: u32, pub stake: u64,
    pub entry_raw: i64, pub entry_expo: i32, pub entry_ts: i64,
    pub max_payout: u64, pub deadline_ts: i64, pub status: u8, pub bump: u8,
}
impl Round { pub const SIZE: usize = 8 + 32 + 1 + 4 + 8 + 8 + 4 + 8 + 8 + 8 + 1 + 1; }
```

- [ ] **Step 2: Write `price.rs` — carry the spike decoder + add staleness**

Copy `parse_price_update` verbatim from `spikes/lazer-probe/programs/lazer-probe/src/lib.rs` into `price.rs` (the `PriceSnapshot { price, exponent, publish_time }` + variable-length `VerificationLevel` handling). Add:

```rust
pub fn read_fresh(price_acct: &AccountInfo, now_ts: i64) -> Result<PriceSnapshot> {
    let data = price_acct.data.borrow();
    let snap = parse_price_update(&data)?;
    require!(now_ts - snap.publish_time <= crate::state::STALE_SECS, RaiderError::StalePrice);
    Ok(snap)
}
```

- [ ] **Step 3: Add `RaiderError` enum + `init_house` instruction to `lib.rs`**

```rust
#[error_code]
pub enum RaiderError {
    StalePrice, BadPrice, RoundAlreadyOpen, NoOpenRound, InsufficientPlayerBalance,
    HouseUndercapitalized, BadLeverage, NotOwner, NotYetExpired, MathOverflow,
}

pub fn init_house(ctx: Context<InitHouse>) -> Result<()> {
    let h = &mut ctx.accounts.house;
    h.authority = ctx.accounts.authority.key();
    h.mint = ctx.accounts.mint.key();
    h.balance = 0; h.locked = 0; h.bump = ctx.bumps.house;
    Ok(())
}
```
Add the `InitHouse` context: `house` = `init` PDA seeds `[b"house", mint]` space `HouseBalance::SIZE`, `mint: Account<Mint>`, `authority: Signer`, plus create the vault token account (ATA of the `[b"vault", mint]` authority PDA) for real USDC custody.

- [ ] **Step 4: Write failing test `tests/init.ts`** — create the test mint (`@solana/spl-token createMint`, 6 decimals), call `init_house`, assert `HouseBalance` exists with `balance=0` and the vault ATA exists.

- [ ] **Step 5: Build + deploy + run**

```bash
cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && anchor deploy --provider.cluster devnet
ANCHOR_WALLET=~/.config/solana/lazer-probe.json npx ts-mocha -p ./tsconfig.json -t 1000000 tests/init.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add onchain/raider && git commit -m "feat(raider): state + price decoder + init_house with vault custody"
```

---

## Task 5: `buy_in` (deposit) + `withdraw` (owner-only) — the non-custodial invariant

**Files:** Modify `onchain/raider/programs/raider/src/lib.rs`; Create `onchain/raider/tests/deposit.ts`

- [ ] **Step 1: Add `buy_in`** — context: `owner: Signer`, `player` = `init_if_needed` PDA `[b"player", owner, mint]`, `owner_token` (owner's USDC ATA), `vault_token` (the `[b"vault", mint]` ATA), `token_program`. Body: CPI `token::transfer(owner_token → vault_token, amount)` signed by owner; `player.balance = player.balance.checked_add(amount).ok_or(RaiderError::MathOverflow)?`; set `owner/mint/bump` on first init.

- [ ] **Step 2: Add `withdraw` (owner-only)**

```rust
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let player = &mut ctx.accounts.player;
    require_keys_eq!(player.owner, ctx.accounts.owner.key(), RaiderError::NotOwner);
    require!(player.balance >= amount, RaiderError::InsufficientPlayerBalance);
    player.balance -= amount;
    let mint = ctx.accounts.mint.key();
    let seeds = &[b"vault".as_ref(), mint.as_ref(), &[ctx.bumps.vault_authority]];
    token::transfer(
        CpiContext::new_with_signer(/* vault_token -> owner_token */ ..., &[seeds]),
        amount,
    )?;
    Ok(())
}
```
Context `Withdraw`: `owner: Signer`, `player` = PDA `[b"player", owner, mint]` (so it re-derives from the signer — a non-owner gets a different PDA / constraint failure), `vault_authority` PDA `[b"vault", mint]`, `vault_token`, `owner_token`, `mint`, `token_program`.

- [ ] **Step 3: Write the test incl. the non-custodial assert**

```ts
// deposit.ts
it("buy_in credits player balance and moves real USDC to the vault", async () => { /* mint to owner, buy_in 10 USDC, assert player.balance==10e6 and vault ATA==10e6 */ });
it("owner can withdraw their balance back to their ATA", async () => { /* withdraw 4e6, assert owner ATA up 4e6, player.balance==6e6 */ });
it("a NON-OWNER cannot withdraw the player's funds", async () => {
  const attacker = anchor.web3.Keypair.generate();
  // fund attacker for fees, sign withdraw with attacker as owner against the victim's player PDA
  await assert.rejects(programAsAttacker.methods.withdraw(new BN(1e6)).accounts({ ... victimPlayerPda ... }).signers([attacker]).rpc());
});
```

- [ ] **Step 4: Build + deploy + run** — Expected: 3/3 pass, the non-owner withdraw REJECTED.

- [ ] **Step 5: Commit** — `git commit -m "feat(raider): buy_in + owner-only withdraw (non-custodial invariant enforced + tested)"`

---

## Task 6: `delegate_session` — co-delegate Player + House + Round to the ER

**Files:** Modify `lib.rs`; Create `tests/delegate.ts`

- [ ] **Step 1: Ensure Player/Round exist on L1, then delegate all three** — add an `init_round` (or fold into `buy_in`) that creates the `Round` PDA `[b"round", owner]` with `status=0`. Add `delegate_session` that calls `delegate_pda` (spike pattern) on `player`, `house`, and `round`, each with `DelegateConfig { validator: remaining_accounts.first(), ..Default::default() }`. Use the `#[delegate]` context macro; pass the validator as a remaining account (Task 2 proved the multi-PDA case).

- [ ] **Step 2: Write the test** — `tests/delegate.ts`: buy_in, init_round, `delegate_session` with `[VALIDATOR]`; poll until all three PDAs' owner flips to `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.

- [ ] **Step 3: Build + deploy + run** — Expected: all three delegated within ~15s.

- [ ] **Step 4: Commit** — `git commit -m "feat(raider): co-delegate player+house+round to the ER"`

---

## Task 7: `open` (ER) — entry snapshot + house max-payout pre-lock

**Files:** Modify `lib.rs`; Create `tests/open.ts`

- [ ] **Step 1: Implement `open`**

```rust
pub fn open(ctx: Context<OpenRound>, dir: i8, lev: u32, stake: u64) -> Result<()> {
    require!(lev >= settle::RMIN && lev <= settle::RMAX, RaiderError::BadLeverage);
    require!(dir == 1 || dir == -1, RaiderError::BadLeverage);
    let now = Clock::get()?.unix_timestamp;
    let snap = price::read_fresh(&ctx.accounts.price_update, now)?;
    require!(snap.price > 0, RaiderError::BadPrice); // entry is a divisor at close — never store <= 0 (settle::equity_fp would div-by-zero)
    let (player, house, round) = (&mut ctx.accounts.player, &mut ctx.accounts.house, &mut ctx.accounts.round);
    require!(round.status != 1, RaiderError::RoundAlreadyOpen);
    require!(player.balance >= stake, RaiderError::InsufficientPlayerBalance);
    let max_payout = settle::max_payout(stake);
    require!(house.balance.saturating_sub(house.locked) >= max_payout, RaiderError::HouseUndercapitalized);
    player.balance -= stake;
    house.locked += max_payout;
    round.owner = player.owner; round.dir = dir; round.lev = lev; round.stake = stake;
    round.entry_raw = snap.price; round.entry_expo = snap.exponent; round.entry_ts = snap.publish_time;
    round.max_payout = max_payout; round.deadline_ts = now + state::MAX_ROUND_SECS; round.status = 1;
    Ok(())
}
```
Context `OpenRound`: `player`/`house`/`round` all `#[account(mut)]` (delegated; read `authority` carefully per the Phase-0 gotcha if Anchor re-serialization fights delegation — use the spike's working pattern), `price_update: AccountInfo` (the Lazer feed), and the `player_authority: Signer` (Phase 1 = owner; session-key-ready slot).

- [ ] **Step 2: Write `tests/open.ts`** — after delegate, call `open(1, 100, 1e6)` on the **ER provider**; fetch `Round` from the ER; assert `status==1`, `entry_raw>0`, `entry_ts` sane recent unix; assert `house.locked == max_payout(1e6) == 23_750_000`; assert `player.balance` dropped by `1e6`. (House must be pre-funded ≥ 23.75 USDC — fund it in setup.)

- [ ] **Step 3: Build + deploy + run** — Expected: PASS. (Note: house needs ≥ `max_payout` free or `open` rejects — verify the rejection too with an under-funded house in a second test.)

- [ ] **Step 4: Commit** — `git commit -m "feat(raider): open round on ER with entry snapshot + house max-payout pre-lock"`

---

## Task 8: `close` (ER) — settle at exit, move value, unlock

**Files:** Modify `lib.rs`; Create `tests/close.ts`

- [ ] **Step 1: Implement `close`**

```rust
pub fn close(ctx: Context<CloseRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let snap = price::read_fresh(&ctx.accounts.price_update, now)?;
    let (player, house, round) = (&mut ctx.accounts.player, &mut ctx.accounts.house, &mut ctx.accounts.round);
    require!(round.status == 1, RaiderError::NoOpenRound);
    let (_outcome, payout) = settle::settle(round.dir, round.lev, round.stake, round.entry_raw, snap.price);
    let payout = payout.min(round.max_payout); // never exceed the pre-lock
    player.balance = player.balance.checked_add(payout).ok_or(RaiderError::MathOverflow)?;
    house.balance = house.balance.checked_add(round.stake).ok_or(RaiderError::MathOverflow)?
        .checked_sub(payout).ok_or(RaiderError::MathOverflow)?;
    house.locked = house.locked.checked_sub(round.max_payout).ok_or(RaiderError::MathOverflow)?;
    round.status = 2;
    Ok(())
}
```
Context `CloseRound`: same three mutable delegated PDAs + `price_update` + `player_authority: Signer`.

- [ ] **Step 2: Write `tests/close.ts`** with the conservation + provable-fairness asserts:

```ts
it("close settles at exit, conserves value, and is recomputable off-chain", async () => {
  const before = await sumBalances(); // player.balance + house.balance + house.locked
  const r = await programER.account.round.fetch(roundPda);
  await programER.methods.close().accounts({ ...delegated, priceUpdate: BTC_FEED, playerAuthority: owner.publicKey }).rpc({ skipPreflight: true });
  const exit = await readLazerRaw(BTC_FEED);              // decode the same feed in TS
  const expected = settleTs(r.dir, r.lev, r.stake.toNumber(), r.entryRaw.toNumber(), exit); // TS mirror of settle.rs
  const after = await programER.account.playerBalance.fetch(playerPda);
  assert.equal(payoutDelta(after), expected, "on-chain payout must equal off-chain recompute"); // PROVABLE FAIRNESS
  assert.equal(await sumBalances(), before, "value conserved across player+house"); // CONSERVATION
});
```
Implement `settleTs(...)` as an exact integer mirror of `settle.rs` in the test file (the proof that anyone can recompute). **CRITICAL (review finding): write it in `BigInt`, NOT by calling the float `@perps/engine` `payoutOf`/`Math.floor`.** The float engine can be off-by-one vs the integer math on IEEE-754 boundaries (a product landing on `…816.9999998`), and the on-chain Rust integer result is the *correct* one — so a float mirror would assert against the wrong number and spuriously fail. Mirror `settle.rs`'s exact i128/u128 truncating ops in `BigInt`.

- [ ] **Step 3: Build + deploy + run** — Expected: PASS, both asserts green.

- [ ] **Step 4: Commit** — `git commit -m "feat(raider): close round on ER — settle at exit, conserved value, provably recomputable"`

---

## Task 9: `force_close` (permissionless, time-bounded liveness backstop)

**Files:** Modify `lib.rs`; Create `tests/forceclose.ts`

- [ ] **Step 1: Implement `force_close`** — identical settle to `close`, but: `signer` is ANY `Signer` (no owner check), and it requires `now >= round.deadline_ts` (else `RaiderError::NotYetExpired`). Settles at the current Lazer price and unlocks. (Set `MAX_ROUND_SECS` low via a test-only override or just wait it out with a short deadline for the test — or add a test feature flag that shrinks `MAX_ROUND_SECS`.)

- [ ] **Step 2: Write `tests/forceclose.ts`** — open a round; have a **different** keypair attempt `force_close` before the deadline → REJECTED (`NotYetExpired`); after the deadline → SUCCEEDS, round settled, house unlocked. Proves a stalled/abandoned round can always be unwound by anyone.

- [ ] **Step 3: Build + deploy + run** — Expected: pre-deadline rejected, post-deadline succeeds.

- [ ] **Step 4: Commit** — `git commit -m "feat(raider): permissionless time-bounded force_close (liveness backstop)"`

---

## Task 10: `commit_and_undelegate` + end-to-end driver on devnet

**Files:** Modify `lib.rs`; Create `onchain/raider/tests/raider.ts` (the canonical end-to-end driver)

- [ ] **Step 1: Add `commit_and_undelegate`** — `MagicIntentBundleBuilder::new(...).commit_and_undelegate(&[player, house, round]).build_and_invoke()` (spike pattern, all three accounts).

- [ ] **Step 2: Write the full end-to-end driver** mirroring `spikes/lazer-probe/tests/lazer-probe.ts` structure (two providers, before-hook logging). Sequence: createMint → init_house + fund house → buy_in (player) → init_round → delegate_session → open → (advance a few samples) → close → commit_and_undelegate → withdraw. Asserts: delegated owners flip; `open` locks 23.75×; `close` conserves + matches the TS recompute; after undelegate the final balances land on L1; `withdraw` returns real USDC to the owner; non-owner withdraw rejected (reuse Task 5's attacker).

- [ ] **Step 3: Run the whole suite on devnet**

```bash
cd onchain/raider && ~/.avm/bin/anchor-0.32.1 build && anchor deploy --provider.cluster devnet
ANCHOR_WALLET=~/.config/solana/lazer-probe.json npx ts-mocha -p ./tsconfig.json -t 1000000 tests/raider.ts
```
Expected: full loop GREEN end-to-end.

- [ ] **Step 4: Commit** — `git commit -m "feat(raider): commit/undelegate + full devnet end-to-end driver (buy-in→open→close→withdraw)"`

---

## Task 11: Latency re-measurement + RESULT.md

Replace the Phase-0 1448ms worst-case datum with a properly-measured number (research §7.5).

**Files:** Create `onchain/raider/tests/latency.ts`, `onchain/raider/RESULT.md`

- [ ] **Step 1: Write the latency probe** — open a round, then loop `close`-style reads using: nearest validator (Magic Router `getClosestValidator()` if available, else compare `devnet.magicblock.app` vs `devnet-as.magicblock.app`), submit WITHOUT awaiting confirmation, and time `(submit → first `processed` account-change)` via a websocket `accountSubscribe` on the Round PDA. Report p50/p95 for both `processed` and `confirmed`.

- [ ] **Step 2: Run it** and record p50/p95 from the current machine's region (note the geography honestly).

- [ ] **Step 3: Write `RESULT.md`** — verdict (GREEN/AMBER) + per-assumption table (two-account co-delegation, fixed-point parity, house solvency pre-lock, non-custodial withdraw, force_close liveness, latency p50/p95), the deployed program id + PDAs, reproduction commands, devnet SOL cost, and Phase-2 carry-forwards (intra-round liq, time-cap, actions, session keys, the multi-player house-contention note).

- [ ] **Step 4: Commit** — `git commit -m "docs(raider): RESULT.md — phase-1 verdicts + proper ER latency re-measurement"`

---

## Self-Review notes (for the executor)

- **Spec coverage:** every spec bullet maps to a task — vaults/ledgers (T4), buy-in/withdraw + non-custodial invariant (T5), co-delegation (T2/T6), open + house pre-lock (T7), close + settle + provable recompute (T8), force_close liveness (T9), undelegate + e2e (T10), fixed-point settle (T3), latency + RESULT (T11).
- **Front-loaded risk:** T2 (two-account co-delegation) and T3 (fixed-point parity) are the make-or-break unknowns — do them before building instructions on top.
- **ER API exactness:** `delegate_pda` / `DelegateConfig` / `MagicIntentBundleBuilder` and the delegated-account re-serialization gotcha are taken from the *working* spike (`spikes/lazer-probe/programs/lazer-probe/src/lib.rs`) — copy that pattern verbatim rather than guessing; if a signature differs, the spike is ground truth.
- **Type consistency:** `PlayerBalance.balance`, `HouseBalance.{balance,locked}`, `Round.{dir,lev,stake,entry_raw,max_payout,deadline_ts,status}`, and `settle::{equity_fp,terminal,payout,max_payout,settle}` names are used identically across T3–T10.
- **Deferred, by design:** session-key issuance, the wallet front-end, intra-round liquidation, the 60s game time-cap, and flip/lever actions are NOT in this plan — they are Phase-2/client-phase.
