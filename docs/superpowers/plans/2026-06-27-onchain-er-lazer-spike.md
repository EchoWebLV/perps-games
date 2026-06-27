# Phase 0 Spike — Lazer Price Inside MagicBlock ER — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on Solana devnet that a custom Anchor program can be delegated to the MagicBlock Ephemeral Rollup, read the live Pyth Lazer BTC/USD price *inside the rollup*, and commit/undelegate its state back to L1 — measuring latency and confirming the price is live.

**Architecture:** A throwaway Anchor program `lazer-probe` with one PDA (`Probe`). It is initialized + delegated on the base layer, then on the ER an instruction reads MagicBlock's resident Pyth Lazer BTC/USD feed account (`PriceUpdateV2`) and writes the price into `Probe`. A TypeScript driver runs the full lifecycle, fires N sample txs on the ER measuring round-trip latency, asserts the on-chain price is a live BTC price (timestamp advances, value in a plausible band), then commits + undelegates and confirms the final state landed on L1. Disposable — lives in `spikes/`, may be deleted after Phase 1 begins.

**Tech Stack:** Rust, Anchor `0.32.1`, `ephemeral-rollups-sdk 0.14.4` (anchor-compat), `pyth-solana-receiver-sdk 0.6.0`, `@coral-xyz/anchor`, `@magicblock-labs/ephemeral-rollups-sdk` (TS), Solana CLI, devnet + `https://devnet.magicblock.app`.

---

## Spec

Implements `docs/superpowers/specs/2026-06-27-onchain-er-lazer-spike-design.md`. Branch: `onchain-er-rebuild`.

## Reference source (verified 2026-06-27, copy from these — do not invent)

- Delegation lifecycle program: `magicblock-labs/magicblock-engine-examples` → `anchor-counter/programs/public-counter/src/lib.rs` (anchor 0.32.1 / ers-sdk 0.14.4).
- Delegation TS client: same repo → `anchor-counter/tests/public-counter.ts`.
- Price-read consumer + feed addresses: `magicblock-labs/real-time-pricing-oracle` → `README.md` and `program/ephemeral-oracle/...` (pyth-solana-receiver-sdk 0.6.0).

**Known devnet facts:**
- ER + feeds cluster RPC: `https://devnet.magicblock.app`, WS `wss://devnet.magicblock.app`.
- Base devnet RPC: `https://api.devnet.solana.com`.
- Pyth Lazer feed accounts on that ER cluster: SOL/USD `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`, **BTC/USD `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr`**, ETH/USD `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG`, USDC/USD `Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541`.
- Delegation Program id: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.
- Example ER validator pubkey (non-local default in the counter test): `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`. **The correct validator must be the one operating the cluster that hosts the feed accounts — confirming this pairing is part of the spike (Task 7).**

## ⚠️ The one real risk this plan front-loads (Task 2)

Two MagicBlock examples use **different** dependency sets:
- delegation (current): `anchor-lang 0.32.1` + `ephemeral-rollups-sdk 0.14.4` (`anchor-compat`), API = `MagicIntentBundleBuilder`.
- pyth read: `anchor-lang 0.31.1` + `ephemeral-rollups-sdk 0.2.4` (`anchor`) + `pyth-solana-receiver-sdk 0.6.0`, API = `delegate_account` / `commit_and_undelegate_accounts`.

This spike needs **delegation + pyth-read in one program**. Task 2 exists to prove that trio compiles. **Happy path:** anchor 0.32.1 + ers-sdk 0.14.4 + pyth 0.6.0. **Documented fallback if `anchor build` reports a version conflict:** drop to the oracle example's trio (anchor 0.31.1 + ers-sdk 0.2.4 + pyth 0.6.0) and use the older delegation API (shown in Task 4's fallback note). Record which trio worked in `RESULT.md`.

## File Structure

All under `spikes/lazer-probe/` (throwaway, not wired into `server/` or `redline3d/`):

- `Anchor.toml` — Anchor workspace, devnet provider.
- `Cargo.toml` — Rust workspace.
- `programs/lazer-probe/Cargo.toml` — program crate + pinned deps.
- `programs/lazer-probe/src/lib.rs` — the program (one file: `Probe` account + `initialize`, `sample`, `delegate`, `commit_and_undelegate`).
- `tests/lazer-probe.ts` — the driver: lifecycle + latency + liveness assertions.
- `package.json`, `tsconfig.json` — TS deps for the driver.
- `.env.example` — endpoints + validator + keypair path.
- `RESULT.md` — the deliverable: 4 pass/fail verdicts + measured median latency + surprises.

---

## Task 1: Toolchain + funded devnet keypair

**Files:** none (environment prep).

- [ ] **Step 1: Verify toolchain versions**

Run:
```bash
solana --version && anchor --version && rustc --version
```
Expected: `solana-cli` ≥ 1.18, `anchor-cli 0.32.1`, `rustc` ≥ 1.79. If `anchor --version` differs, install via avm:
```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && avm install 0.32.1 && avm use 0.32.1
```

- [ ] **Step 2: Create a dedicated devnet keypair and set devnet**

Run:
```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/lazer-probe.json
solana config set --keypair ~/.config/solana/lazer-probe.json --url https://api.devnet.solana.com
solana address
```
Expected: prints a base58 pubkey.

- [ ] **Step 3: Fund it on devnet (need ~3 SOL for deploy)**

Run:
```bash
solana airdrop 2 && sleep 5 && solana airdrop 2 && solana balance
```
Expected: balance ≥ 3 SOL. (If the faucet rate-limits, retry or use https://faucet.solana.com.)

- [ ] **Step 4: Commit a note (no code yet)**

```bash
mkdir -p spikes/lazer-probe
printf '# lazer-probe spike\nThrowaway Phase 0 spike. See docs/superpowers/plans/2026-06-27-onchain-er-lazer-spike.md\n' > spikes/lazer-probe/README.md
git add spikes/lazer-probe/README.md
git commit -m "chore(spike): scaffold lazer-probe dir"
```

---

## Task 2: Scaffold the Anchor workspace and prove the dependency trio compiles

This is the risk-killer. Get an **empty** program building with all three deps before writing logic.

**Files:**
- Create: `spikes/lazer-probe/Anchor.toml`
- Create: `spikes/lazer-probe/Cargo.toml`
- Create: `spikes/lazer-probe/programs/lazer-probe/Cargo.toml`
- Create: `spikes/lazer-probe/programs/lazer-probe/src/lib.rs` (minimal stub)

- [ ] **Step 1: Init the Anchor project**

Run:
```bash
cd spikes && anchor init lazer-probe --no-git && cd lazer-probe
```
Expected: standard Anchor layout under `spikes/lazer-probe/`.

- [ ] **Step 2: Pin program dependencies**

Overwrite `spikes/lazer-probe/programs/lazer-probe/Cargo.toml`:
```toml
[package]
name = "lazer-probe"
version = "0.1.0"
description = "Throwaway ER+Lazer spike"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "lazer_probe"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "0.14.4", features = ["anchor-compat"] }
pyth-solana-receiver-sdk = "0.6.0"
```

- [ ] **Step 3: Minimal program stub**

Overwrite `spikes/lazer-probe/programs/lazer-probe/src/lib.rs`:
```rust
use anchor_lang::prelude::*;

declare_id!("Lprobe1111111111111111111111111111111111111");

#[program]
pub mod lazer_probe {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

- [ ] **Step 4: Build — this is the dependency-resolution test**

Run:
```bash
anchor build
```
Expected: **PASS** (compiles). 
**If it FAILS with a version conflict** (e.g. `anchor-lang` required by `pyth-solana-receiver-sdk` ≠ 0.32.1): apply the documented fallback trio — set `anchor-lang = "=0.31.1"`, `ephemeral-rollups-sdk = { version = "0.2.4", features = ["anchor"] }`, keep `pyth-solana-receiver-sdk = "0.6.0"` — and rebuild. Record the winning trio in a scratch note for `RESULT.md`. The later tasks call out the one API difference this causes (Task 4).

- [ ] **Step 5: Commit**

```bash
git add spikes/lazer-probe/Anchor.toml spikes/lazer-probe/Cargo.toml spikes/lazer-probe/programs/lazer-probe/Cargo.toml spikes/lazer-probe/programs/lazer-probe/src/lib.rs
git commit -m "feat(spike): anchor scaffold + pinned ER/pyth deps build"
```

---

## Task 3: Program — `Probe` account + `initialize` + `sample` (read Lazer price)

**Files:**
- Modify: `spikes/lazer-probe/programs/lazer-probe/src/lib.rs`

- [ ] **Step 1: Write the account + initialize + sample**

Replace `src/lib.rs` body (keep `declare_id!` line value from scaffold) with:
```rust
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

declare_id!("Lprobe1111111111111111111111111111111111111"); // replaced in Task 5

pub const PROBE_SEED: &[u8] = b"probe";

#[program]
pub mod lazer_probe {
    use super::*;

    /// Create the Probe PDA on the base layer.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.last_price = 0;
        probe.last_expo = 0;
        probe.last_ts = 0;
        probe.tick_count = 0;
        Ok(())
    }

    /// Read the resident Pyth Lazer feed account and store the price.
    /// Runs on the ER (where the feed account is refreshed).
    pub fn sample(ctx: Context<Sample>) -> Result<()> {
        let price_update = PriceUpdateV2::try_deserialize_unchecked(
            &mut (*ctx.accounts.price_update.data.borrow()).as_ref(),
        )
        .map_err(Into::<Error>::into)?;

        // The feed id is the account key itself on the MagicBlock oracle.
        let feed_id: [u8; 32] = ctx.accounts.price_update.key().to_bytes();
        let maximum_age: u64 = 120; // seconds; fails if the feed is stale
        let price = price_update.get_price_no_older_than(&Clock::get()?, maximum_age, &feed_id)?;

        let probe = &mut ctx.accounts.probe;
        probe.last_price = price.price;
        probe.last_expo = price.exponent;
        probe.last_ts = price_update.price_message.publish_time;
        probe.tick_count += 1;
        msg!(
            "probe price={} expo={} ts={} n={}",
            probe.last_price, probe.last_expo, probe.last_ts, probe.tick_count
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 8 + 4 + 8 + 8, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sample<'info> {
    #[account(mut, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
    /// CHECK: the Pyth Lazer price feed account, validated by deserialization.
    pub price_update: AccountInfo<'info>,
}

#[account]
pub struct Probe {
    pub last_price: i64,
    pub last_expo: i32,
    pub last_ts: i64,
    pub tick_count: u64,
}
```

- [ ] **Step 2: Build**

Run:
```bash
anchor build
```
Expected: PASS. (If `price.price`/`price.exponent`/`price_message.publish_time` field names mismatch the installed pyth sdk, the compiler names the right field — adjust to the struct it reports; the README-verified call is `get_price_no_older_than` returning `.price`/`.conf`/`.exponent`.)

- [ ] **Step 3: Commit**

```bash
git add spikes/lazer-probe/programs/lazer-probe/src/lib.rs
git commit -m "feat(spike): Probe account + sample reads Lazer PriceUpdateV2"
```

---

## Task 4: Program — delegation lifecycle (`delegate`, `commit_and_undelegate`)

Copy the macro usage from `public-counter/src/lib.rs` exactly.

**Files:**
- Modify: `spikes/lazer-probe/programs/lazer-probe/src/lib.rs`

- [ ] **Step 1: Add the ephemeral imports + program attribute**

At the top of `src/lib.rs`, add under the existing `use` lines:
```rust
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
```
And change `#[program]` to be preceded by `#[ephemeral]`:
```rust
#[ephemeral]
#[program]
pub mod lazer_probe {
```

- [ ] **Step 2: Add the delegate + undelegate instructions inside the module**

Add to the `pub mod lazer_probe` block:
```rust
    /// Delegate the Probe PDA to the ER (base-layer tx).
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[PROBE_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Commit + undelegate the Probe back to L1 (ER tx).
    pub fn commit_and_undelegate(ctx: Context<ProbeCommit>) -> Result<()> {
        ctx.accounts.probe.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
```

- [ ] **Step 3: Add the two account contexts at the bottom**

```rust
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct ProbeCommit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED], bump)]
    pub probe: Account<'info, Probe>,
}
```

> **Fallback-trio note (only if Task 2 used anchor 0.31.1 / ers-sdk 0.2.4):** the `MagicIntentBundleBuilder` type does not exist there. Instead import `use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;` and replace the builder call with `commit_and_undelegate_accounts(ctx.accounts.payer.to_account_info(), vec![&ctx.accounts.probe.to_account_info()], ctx.accounts.magic_context.to_account_info(), ctx.accounts.magic_program.to_account_info())?;`. The `#[delegate]`/`#[commit]`/`#[ephemeral]` macros and `delegate_pda` are the same.

- [ ] **Step 4: Build**

Run:
```bash
anchor build
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spikes/lazer-probe/programs/lazer-probe/src/lib.rs
git commit -m "feat(spike): delegate + commit_and_undelegate lifecycle"
```

---

## Task 5: Deploy to devnet + sync program id

**Files:**
- Modify: `spikes/lazer-probe/programs/lazer-probe/src/lib.rs` (declare_id)
- Modify: `spikes/lazer-probe/Anchor.toml`

- [ ] **Step 1: Set Anchor.toml to devnet**

Ensure `spikes/lazer-probe/Anchor.toml` has:
```toml
[provider]
cluster = "Devnet"
wallet = "~/.config/solana/lazer-probe.json"

[programs.devnet]
lazer_probe = "Lprobe1111111111111111111111111111111111111"
```

- [ ] **Step 2: Deploy**

Run:
```bash
anchor deploy --provider.cluster devnet
```
Expected: prints `Program Id: <REAL_ID>`.

- [ ] **Step 3: Replace the placeholder id in both files and rebuild/redeploy**

Set `declare_id!("<REAL_ID>")` in `src/lib.rs` and `lazer_probe = "<REAL_ID>"` in `Anchor.toml`, then:
```bash
anchor build && anchor deploy --provider.cluster devnet
```
Expected: deploy succeeds (upgrade). `anchor keys list` shows the same id in both places.

- [ ] **Step 4: Commit**

```bash
git add spikes/lazer-probe/programs/lazer-probe/src/lib.rs spikes/lazer-probe/Anchor.toml
git commit -m "chore(spike): deploy to devnet + sync program id"
```

---

## Task 6: Driver config + sanity-read the feed from the ER

Before any delegation, confirm our chosen ER endpoint actually serves a live BTC feed — if this fails, nothing downstream can work.

**Files:**
- Create: `spikes/lazer-probe/.env.example`
- Create: `spikes/lazer-probe/package.json`
- Create: `spikes/lazer-probe/tests/lazer-probe.ts` (sanity portion)

- [ ] **Step 1: `.env.example`**

```bash
BASE_RPC=https://api.devnet.solana.com
ER_RPC=https://devnet.magicblock.app
ER_WS=wss://devnet.magicblock.app
ER_VALIDATOR=MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57
BTC_FEED=71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr
ANCHOR_WALLET=/Users/<you>/.config/solana/lazer-probe.json
```

- [ ] **Step 2: `package.json`**

```json
{
  "name": "lazer-probe-driver",
  "private": true,
  "scripts": { "spike": "ts-mocha -p ./tsconfig.json -t 1000000 tests/lazer-probe.ts" },
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@magicblock-labs/ephemeral-rollups-sdk": "^0.2.5",
    "@solana/web3.js": "^1.95.0"
  },
  "devDependencies": { "ts-mocha": "^10.0.0", "mocha": "^10.0.0", "@types/mocha": "^10.0.0", "typescript": "^5.5.0" }
}
```
Run `npm install` in `spikes/lazer-probe/`. Expected: installs clean.

- [ ] **Step 3: Sanity-read test — feed is live on the ER endpoint**

Create `tests/lazer-probe.ts`:
```ts
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { strict as assert } from "assert";

const BTC_FEED = new PublicKey(process.env.BTC_FEED!);
const erConn = new anchor.web3.Connection(process.env.ER_RPC!, { commitment: "confirmed" });

describe("lazer-probe spike", () => {
  it("ER endpoint serves a non-empty BTC feed account", async () => {
    const info = await erConn.getAccountInfo(BTC_FEED);
    assert.ok(info, "BTC feed account not found on ER_RPC — wrong endpoint/cluster");
    assert.ok(info.data.length > 0, "BTC feed account is empty");
    console.log(`BTC feed account size=${info.data.length} owner=${info.owner.toBase58()}`);
  });
});
```

- [ ] **Step 4: Run the sanity test**

Run:
```bash
cd spikes/lazer-probe && cp .env.example .env && set -a && . ./.env && set +a && npm run spike
```
Expected: PASS, logs a non-zero account size. **If it fails, the spike has found something important** (the feeds are not on `ER_RPC`) — record it and try `ER_RPC=https://devnet-as.magicblock.app/` before continuing.

- [ ] **Step 5: Commit**

```bash
git add spikes/lazer-probe/.env.example spikes/lazer-probe/package.json spikes/lazer-probe/tests/lazer-probe.ts spikes/lazer-probe/tsconfig.json
git commit -m "feat(spike): driver config + ER feed sanity read"
```

---

## Task 7: Driver — init, delegate, sample-loop on ER (latency + liveness)

**Files:**
- Modify: `spikes/lazer-probe/tests/lazer-probe.ts`

- [ ] **Step 1: Add providers, program handles, and the lifecycle test**

Append to `tests/lazer-probe.ts` (inside the `describe` block, after the sanity `it`):
```ts
  const baseProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(process.env.BASE_RPC!, { commitment: "confirmed" }),
    anchor.Wallet.local(),
  );
  anchor.setProvider(baseProvider);
  const erProvider = new anchor.AnchorProvider(
    new anchor.web3.Connection(process.env.ER_RPC!, {
      wsEndpoint: process.env.ER_WS!, commitment: "confirmed",
    }),
    anchor.Wallet.local(),
  );

  const program = anchor.workspace.LazerProbe as anchor.Program;
  const programER = new anchor.Program(program.idl, erProvider);
  const [probePDA] = PublicKey.findProgramAddressSync([Buffer.from("probe")], program.programId);
  const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
  const N = 50;
  const latencies: number[] = [];

  it("initialize Probe on base layer", async () => {
    const tx = await program.methods.initialize().accounts({ user: baseProvider.wallet.publicKey }).transaction();
    await baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
    const acct = await baseProvider.connection.getAccountInfo(probePDA);
    assert.equal(acct!.owner.toBase58(), program.programId.toBase58(), "Probe not owned by program after init");
  });

  it("delegate Probe to the ER (owner flips to delegation program)", async () => {
    const validator = new PublicKey(process.env.ER_VALIDATOR!);
    const tx = await program.methods.delegate()
      .accounts({ payer: baseProvider.wallet.publicKey, pda: probePDA })
      .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }])
      .transaction();
    await baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
    await new Promise((r) => setTimeout(r, 3000));
    const acct = await baseProvider.connection.getAccountInfo(probePDA);
    assert.equal(acct!.owner.toBase58(), DELEGATION_PROGRAM.toBase58(), "Probe owner did not flip to delegation program");
  });

  it(`sample ${N}x on the ER — measures latency, proves live price`, async () => {
    const btcFeed = new PublicKey(process.env.BTC_FEED!);
    let prevTs = 0, advanced = 0;
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      await programER.methods.sample().accounts({ probe: probePDA, priceUpdate: btcFeed }).rpc();
      latencies.push(Date.now() - start);
      const probe: any = await programER.account.probe.fetch(probePDA);
      const ts = Number(probe.lastTs);
      if (ts > prevTs) advanced++;
      prevTs = ts;
    }
    const probe: any = await programER.account.probe.fetch(probePDA);
    const usd = Number(probe.lastPrice) * Math.pow(10, Number(probe.lastExpo));
    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)];
    console.log(`MEDIAN ER ROUND-TRIP: ${median}ms (min ${latencies[0]}, max ${latencies.at(-1)})`);
    console.log(`BTC price on-chain: $${usd.toFixed(2)} | ts advanced ${advanced}/${N - 1} samples | ticks ${probe.tickCount}`);
    assert.equal(Number(probe.tickCount), N, "tick_count mismatch");
    assert.ok(usd > 10000 && usd < 500000, `implausible BTC price $${usd} — not a live feed`);
    assert.ok(advanced >= 1, "last_ts never advanced — feed appears frozen, not live");
    assert.ok(median < 150, `median ER latency ${median}ms exceeds 150ms target`);
  });
```

- [ ] **Step 2: Run**

Run:
```bash
cd spikes/lazer-probe && set -a && . ./.env && set +a && npm run spike
```
Expected: PASS. Console prints the median latency, the live BTC price, and ts-advance count. **Record these numbers.** Latency assertion is a target, not a hard gate — if it exceeds 150ms but everything else passes, downgrade that one assertion to a `console.warn` and note the real number in `RESULT.md`.

- [ ] **Step 3: Commit**

```bash
git add spikes/lazer-probe/tests/lazer-probe.ts
git commit -m "feat(spike): ER sample loop — latency + live-price assertions"
```

---

## Task 8: Driver — commit/undelegate + L1 round-trip

**Files:**
- Modify: `spikes/lazer-probe/tests/lazer-probe.ts`

- [ ] **Step 1: Add the round-trip test**

Append inside the `describe` block:
```ts
  it("commit + undelegate — final price lands back on L1", async () => {
    const erBefore: any = await programER.account.probe.fetch(probePDA);
    const tx = await programER.methods.commitAndUndelegate()
      .accounts({ payer: erProvider.wallet.publicKey, probe: probePDA }).transaction();
    await erProvider.sendAndConfirm(tx, [], { skipPreflight: true });
    // Poll the base layer until ownership returns to our program (undelegation finalizes async).
    let acct = null, owner = "";
    for (let i = 0; i < 30; i++) {
      acct = await baseProvider.connection.getAccountInfo(probePDA);
      owner = acct!.owner.toBase58();
      if (owner === program.programId.toBase58()) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.equal(owner, program.programId.toBase58(), "Probe did not undelegate back to program within 60s");
    const onL1: any = await program.account.probe.fetch(probePDA);
    assert.equal(Number(onL1.lastPrice), Number(erBefore.lastPrice), "committed price does not match ER state");
    console.log(`L1 round-trip OK: last_price ${onL1.lastPrice} persisted, owner back to program`);
  });
```

- [ ] **Step 2: Run the full suite end to end**

Run:
```bash
cd spikes/lazer-probe && set -a && . ./.env && set +a && npm run spike
```
Expected: all tests PASS. The undelegate test confirms the price committed on the ER is readable on base devnet.

- [ ] **Step 3: Commit**

```bash
git add spikes/lazer-probe/tests/lazer-probe.ts
git commit -m "feat(spike): commit/undelegate + L1 round-trip assertion"
```

---

## Task 9: Write `RESULT.md` — the deliverable

**Files:**
- Create: `spikes/lazer-probe/RESULT.md`

- [ ] **Step 1: Fill in the four verdicts + measurements**

Create `spikes/lazer-probe/RESULT.md` with the real values observed:
```markdown
# Phase 0 Spike Result — <date>

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| 1 | Custom program delegates to devnet ER | PASS/FAIL | owner flipped to DELeGG… (tx <sig>) |
| 2 | Median ER round-trip < ~150ms | PASS/FAIL | median <N>ms (min/max) over 50 samples |
| 3 | On-chain price is live Lazer BTC | PASS/FAIL | $<price>; ts advanced <a>/49; vs off-chain ~$<x> |
| 4 | Commit + undelegate round-trips to L1 | PASS/FAIL | price <p> readable on base devnet, owner restored |

**Dependency trio that compiled:** anchor <v> / ers-sdk <v> / pyth <v>.
**ER endpoint + validator used:** <ER_RPC> / <validator>.
**Surprises / unknowns resolved:** auth header needed? region/validator pairing? feed staleness? cost?
**Verdict:** GREEN ⇒ proceed to Phase 1 design. / RED ⇒ <which assumption, what constraint, redesign note>.
```

- [ ] **Step 2: Commit**

```bash
git add spikes/lazer-probe/RESULT.md
git commit -m "docs(spike): Phase 0 result — ER+Lazer verdicts + latency"
```

---

## Self-Review

**Spec coverage:** Goal/4 assumptions → Task 5 (delegate), Task 7 (read live price + latency), Task 8 (commit/undelegate round-trip), Task 9 (written verdicts). ✓ Non-goals (no USDC/vault/leverage/house/UI) — plan adds none. ✓ "Ground-truth cross-check" → Task 7 uses a plausible-BTC-band + ts-advance assertion as the liveness proof; the off-chain `feed.js` eyeball is optional (recorded in RESULT). ✓ "Unknowns it will surface" (feed pubkey/auth, ER registration, latency, validator pairing) → Task 6 endpoint sanity + Task 7 latency + RESULT notes. ✓

**Placeholder scan:** No vague steps; every code/command step shows the content. The two intentional runtime-discovered values — the deployed program id (Task 5) and the winning dependency trio (Task 2) — have explicit discovery steps, not placeholders. ✓

**Type/name consistency:** `Probe { last_price:i64, last_expo:i32, last_ts:i64, tick_count:u64 }` defined Task 3, read in Tasks 7–8 as camelCase `lastPrice/lastExpo/lastTs/tickCount` (Anchor IDL convention). Instruction `commit_and_undelegate` (Rust) ↔ `commitAndUndelegate` (TS) — matches Anchor casing. `PROBE_SEED="probe"` ↔ TS `Buffer.from("probe")`. Account contexts `Initialize`/`Sample`/`DelegateInput`/`ProbeCommit` referenced consistently. ✓

**Risk handling:** The one genuine risk (delegation + pyth in one crate) is front-loaded to Task 2 with a documented fallback trio + the matching API swap in Task 4. ✓
