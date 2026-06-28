# Phase 1 Result — Core on-chain round (2026-06-28)

**Verdict: 🟢 GREEN — the full money + settlement loop runs entirely on-chain.**

A custom Anchor program (`raider`) was deployed to Solana devnet, and the complete
game loop — real-USDC buy-in, co-delegation of three ledger PDAs to a MagicBlock
Ephemeral Rollup (ER), `open` (entry snapshot + house solvency pre-lock), `close`
(settle against the live Pyth Lazer BTC price *inside the rollup*), `commit_and_undelegate`
(land final state on L1), and owner-only `withdraw` back to real USDC — was proven
end-to-end by two passing drivers:

- `tests/raider.ts` — the canonical full loop, **all 6 load-bearing asserts GREEN** (1 passing, ~35s).
- `tests/forceclose.ts` — the permissionless time-bounded liveness backstop, **GREEN** (1 passing, ~28s).

Settlement is **provably fair**: the on-chain payout is recomputable from the stored
round data alone by an independent integer (`BigInt`) mirror of `settle.rs`, and the
two matched exactly in the e2e run (payout `953705` from long-100x, entry `$60110.50`
→ exit `$60112.90`). Value is **conserved** across the player + house ledgers
(`35000000` before open == after close) and the house lock is fully released at
settlement. Funds are **non-custodial**: a non-owner `withdraw` against the victim's
player PDA is rejected by the seeds/owner constraints.

---

## Assumption verdicts

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| 1 | Two-account co-delegation extends to **three** PDAs (player + house + round) | ✅ PASS | `tests/raider.ts` [1a]: all three owners flip to `DELeGG…`; [1b]: all three restore to the raider program after `commit_and_undelegate` |
| 2 | Fixed-point `settle.rs` is recomputable off-chain (provable fairness) | ✅ PASS | On-chain `round.payout` == independent `BigInt` `settleTs()` mirror == player's credited delta (`953705`); outcome codes match. 6/6 Rust unit tests pass |
| 3 | House solvency pre-lock at `open` | ✅ PASS | `open` locks `max_payout` = stake·23.75 (`23750000`) and debits exactly the stake; an under-funded house rejects with `HouseUndercapitalized` (Task 7 driver) |
| 4 | Value conservation across player + house | ✅ PASS | `tests/raider.ts` [3]: sum(player + house.balance + house.locked) identical before open and after close; lock released to 0 |
| 5 | Non-custodial withdraw (owner-only) | ✅ PASS | [5]: owner `withdraw` returns real USDC (vault −1 USDC, owner ATA +1 USDC); [6]: non-owner withdraw rejected (`ConstraintSeeds`/2006) |
| 6 | `force_close` liveness backstop (permissionless, time-bounded) | ✅ PASS | `tests/forceclose.ts`: a STRANGER's `force_close` before `deadline_ts` → `NotYetExpired`; after it → settles (status=2), `house.locked`=0, value conserved |
| 7 | ER round-trip latency (re-measured, replacing the Phase-0 1448ms datum) | 🟡 AMBER (acceptable, not the ~150ms target) | warm `close`: **p50 390ms / p95 398ms** processed; cold `open`: p50 1172ms / p95 1211ms (public internet, this region) |

---

## 🔴→🟢 Security fix — the price feed was UNAUTHENTICATED (CRITICAL, now closed)

**The bug (confirmed by audit, reproduced, fixed).** `price::read_fresh` validated
ONLY `publish_time` staleness — it never checked the price account's `owner` or the
decoded `feed_id`, and `price_update` was declared as a bare `AccountInfo` (with a
false `/// CHECK: validated by read_fresh()` comment) in `OpenRound`, `CloseRound`,
and `ForceCloseRound`. An attacker could pass **any** account whose bytes decode to a
`PriceUpdateV2` with an attacker-chosen price + a fresh timestamp, force a `Cap`
outcome, and drain the house (the 23.75× pre-lock) → withdraw real USDC.
`force_close` being permissionless made **any abandoned round** drainable. This
defeated both pillars: provable-fairness and house-solvency.

**The fix (defense-in-depth, deployed devnet upgrade `2UehD6ZTMv4…`):**

1. **Feed account pinned (primary, airtight).** `pub const BTC_FEED = pubkey!("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr")`,
   and `#[account(address = BTC_FEED)]` on `price_update` in OpenRound / CloseRound /
   ForceCloseRound. An attacker simply cannot supply an account at a pubkey they don't
   control — Anchor rejects with `ConstraintAddress` (2012) before the body runs.
2. **Owner check in `read_fresh` (defense-in-depth).** `require!(price_acct.owner == &EXPECTED_FEED_OWNER, …)`
   where `EXPECTED_FEED_OWNER = PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` — the Pyth
   receiver program **as the feed is served INSIDE the ER**, where open/close actually
   execute. (⚠️ KEY FINDING: the feed account has a DIFFERENT owner on L1 base devnet —
   `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, the delegation program, because it's
   delegated to the ER. Using the L1 owner would have broken the legitimate in-rollup
   read. Verified live via `getAccountInfo` on `devnet.magicblock.app`.)
3. **Future-dated guard.** `read_fresh` now rejects `publish_time > now + STALE_SECS`
   in addition to the existing lower-bound staleness check.
4. **feed_id assertion (bonus).** The parser now decodes `feed_id` and `read_fresh`
   asserts it equals the BTC/USD `BTC_FEED_ID` (`59642ec3…`).
5. New `RaiderError::UntrustedFeed` (6010) backs (2) and (4).

**Proven CLOSED — `tests/feedauth.ts` (GREEN on the deployed fixed program):**
opens a real round, then attempts BOTH `open` and `close` with a forged
`price_update` (the SystemProgram id) — each **REJECTED with "An address constraint
was violated"**. The SAME setup accepts the real BTC feed (open status=1, close
settled status=2), proving no false-positive lock-out of the legitimate feed. The
forged-feed `open` left the round idle and the house unlocked; the forged-feed `close`
left the open round un-settled (never settled against a forged price).

> **Prod-build note:** this fix was rebuilt + redeployed WITH `--features test-short-deadline`
> (so `forceclose.ts` still works at the 8s deadline). **Production must rebuild WITHOUT it**
> (`MAX_ROUND_SECS = 300`). The address pin / owner / future-date / feed_id checks are
> independent of that feature.

---

## Closed coverage gaps (audit-flagged; Phase-2 machinery builds on these)

- **LIQ outcome on-chain — `tests/liq.ts` (GREEN).** Opens a 2000× LONG and a 2000×
  SHORT, polls the live Lazer feed until it drifts past a 0.06% safe margin of the liq
  band (equity ≤ 0.2 at 2000× ⇒ ~0.04% adverse move), then closes both. Whichever side
  is adverse settles **`outcome=liq` (2), `payout=0`**, `house.locked` released, value
  conserved. Proven on devnet: a −0.068% BTC move liquidated the LONG (payout 0, locked
  0, conserved total 28 750 000). CAP (+ceiling) is NOT deterministically forceable
  against the live feed without a price backdoor we deliberately do NOT add — it stays
  covered by the Rust unit `settle::tests::cap_clamp` + the `payout.min(max_payout)`
  clamp in `settle_round`.
- **Negative gates — `tests/gates.ts` (GREEN).** Deterministic rejections:
  `open(lev=2001)` → `BadLeverage` (6006); `open(dir=0)` → `BadLeverage`;
  double-open → `RoundAlreadyOpen` (6002); close-with-no-open-round → `NoOpenRound`
  (6003); `withdraw` > play balance → `InsufficientPlayerBalance` (6004). Each verified
  to reject AND leave state untouched (round idle / balance unchanged).
- **Vault reconciliation — `tests/raider.ts` ASSERT 4b.** The real program-owned USDC
  vault token balance must be ≥ `player.balance + house.balance` (the ledger can never
  promise more USDC than is custodied). `house.locked` is a reservation OF
  `house.balance`, not an extra claim, so it is not double-counted.

---

## What ran (reproducible)

- **Program id:** `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv` (devnet; upgrade authority = `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM` / `lazer-probe`). ProgramData `ECky8yr4WTfpZveeKVV4s3jH14RfmEz8LsjFeAVAW2pM`.
- **PDA seeds (per-mint / per-owner):**
  - `PlayerBalance` `[b"player", owner, mint]` — play balance ledger.
  - `HouseBalance` `[b"house", mint]` — shared bankroll (`balance` + `locked`).
  - `Round` `[b"round", owner]` — entry snapshot + settlement record.
  - `vault_authority` `[b"vault", mint]` — owns the program-controlled USDC vault ATA.
- **ER endpoint:** `https://devnet.magicblock.app` / `wss://devnet.magicblock.app` (validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`; `devnet.magicblock.app` and `devnet-as.magicblock.app` report the **same** validator).
- **Lazer BTC/USD feed:** `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` (exponent is a **positive magnitude**: USD = `price · 10^(−expo)`).
- **Build:** `~/.avm/bin/anchor-0.32.1 build` (the production build uses `MAX_ROUND_SECS = 300s`).
  - The release profile carries `opt-level = "s"` so the deployed `.so` (390,688 bytes) fits the available devnet deploy-buffer SOL — `"z"` provokes an SBF stack-frame overflow in `crypto-common`'s `[u128;512]` (de)serialize and is NOT used.
- **Reproduction (drivers):**
  ```sh
  cd onchain/raider
  # force_close needs a short deadline so the post-deadline path is testable:
  ~/.avm/bin/anchor-0.32.1 build -- --features test-short-deadline
  # deploy the upgrade (programdata already extended to 440872 bytes → buffer only):
  solana program deploy target/deploy/raider.so \
    --program-id FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv \
    --upgrade-authority ~/.config/solana/lazer-probe.json \
    --keypair ~/.config/solana/lazer-probe.json \
    --url "https://devnet.helius-rpc.com/?api-key=<HELIUS_KEY>"
  # run the loop + liveness + latency drivers:
  HELIUS="https://devnet.helius-rpc.com/?api-key=<HELIUS_KEY>"
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 tests/raider.ts
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 tests/forceclose.ts
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" LAT_N=8 \
    npx ts-mocha -p ./tsconfig.json -t 2000000 tests/latency.ts
  # security + coverage drivers (added with the feed-auth fix):
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 tests/feedauth.ts   # forged feed REJECTED
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 tests/liq.ts        # real on-chain 2000x LIQ
  ANCHOR_WALLET=~/.config/solana/lazer-probe.json BASE_RPC="$HELIUS" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 tests/gates.ts      # BadLeverage/NoOpenRound/etc.
  ```
  > Use a Helius (or other unthrottled) base RPC — public devnet (`api.devnet.solana.com`) is hard rate-limited.
  > **Production rebuild:** drop `--features test-short-deadline` (restores `MAX_ROUND_SECS = 300`).

---

## Latency re-measurement (replaces the Phase-0 1448ms worst-case)

**Methodology** (per the Phase-0 caveat): submit the ER transaction *without awaiting
confirmation* and time `(submit → first `processed` account-change)` via a websocket
`accountSubscribe` on the Round PDA — i.e. the moment a real client could render the
result optimistically. The `confirmed` round-trip (the `.rpc()` resolve) is recorded
alongside for comparison. Measured from **this machine's network region over the public
internet** (not co-located with the validator). Probe: `tests/latency.ts`.

Run: `LAT_N=8` → 8 fresh rounds, 16 ER round-trip samples (validator `MAS1Dt9…`, endpoint `devnet.magicblock.app`).

| Op | Commitment | n | p50 | p95 | min | max |
|---|---|---|---|---|---|---|
| **close** (warm) | processed | 8 | **390ms** | **398ms** | 386ms | 398ms |
| open (cold) | processed | 8 | 1172ms | 1211ms | 1152ms | 1211ms |
| **close** (warm) | confirmed | 8 | 1170ms | 1192ms | 1138ms | 1192ms |
| open (cold) | confirmed | 8 | 1949ms | 2701ms | 1906ms | 2701ms |

**Headline:** the steady-state in-round op (`close`) lands at **p50 390ms / p95 398ms** at
`processed` — a ~3.7× improvement on the Phase-0 1448ms `confirmed`-from-laptop datum,
and the figure a real client renders against. The Phase-0 number was an apples-to-oranges
measurement (confirmed commitment, blocking `.rpc()`), not an ER speed regression.

**Reading the numbers honestly:**
- `open` is always the **first** transaction on a freshly-delegated round, so every
  `open` sample includes the ER's cold-start for that account set; `close` is the
  warm round-trip and is the better proxy for steady-state in-round latency.
- These are **client-observed, public-internet** figures from this region — NOT
  MagicBlock's on-validator execution time (~tens of ms). A co-located client (or the
  game server) would see materially lower numbers; treat these as a conservative
  upper bound for "how laggy does it feel from a laptop."

---

## Notable Phase-1 engineering findings

1. **`commit_and_undelegate` API weight matters for deploy cost.** The
   `MagicIntentBundleBuilder` path pulls in the ers-sdk intent/confidential-transfer
   machinery (~+48KB of `[u128;512]` crypto weight we never use), bloating the `.so`
   to 438KB whose deploy-buffer rent (3.05 SOL) exceeded available devnet SOL. The
   lighter deprecated free function
   `ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts(payer, vec![&player,
   &house, &round], magic_context, magic_program, None)` does the same
   schedule-commit-and-undelegate CPI and shrank the binary to **390,688 bytes**
   (buffer rent **2.72 SOL**). `None` for `magic_fee_vault` is correct: the payer is
   the session signer, not a delegated ephemeral balance account.
2. **Transient ER router error.** The ER occasionally rejects a `delegate` with
   `Unknown action 'undefined'` (a `sendAndConfirm` response-classification hiccup,
   not an on-chain failure). It clears on retry — both the force_close and latency
   drivers saw it once and passed on re-run / per-iteration retry. Production clients
   should retry the delegate idempotently.
3. **Session-signed ER instructions need a session-scoped provider** (provider wallet
   = session key), not `funder-provider + .signers([session])` — the dual-signer path
   surfaces the same "Unknown action 'undefined'" mis-wrap.
4. **`force_close` deadline-test mechanism.** `MAX_ROUND_SECS` is `#[cfg]`-gated: 300s
   in production, **8s** under the `test-short-deadline` cargo feature so the
   post-deadline path is exercisable without a 5-minute wait. **This feature MUST be
   off in any real/mainnet deploy.**

---

## Devnet SOL cost

- The redeploy (upgrade) itself cost ~**0.002 SOL** (the deploy buffer rent is
  refunded on success; `lazer-probe` stayed ~6.8 SOL).
- A one-time **`solana program extend`** (~**0.35 SOL**) grew programdata to 440,872
  bytes; that rent now lives in the ProgramData account (recoverable only by closing
  the program) and means future upgrades need **only** the buffer, no concurrent extend.
- Each driver run spends a few × 0.01 SOL on fresh-session funding + mints/ATAs +
  fees (devnet test value only; reclaimable in principle).
- **Note:** devnet faucets were hard rate-limited for a long stretch during this
  phase; budget SOL ahead of time. The deploy buffer needs ~2.72 SOL liquid (refunded).

---

## Phase-2 carry-forwards (deferred by design)

- **Intra-round liquidation** — Phase 1 settles only at `close`/`force_close` against
  the *current* mark; a position that touched the liq threshold mid-round but
  recovered is NOT liquidated. Phase 2 needs a path-aware liq (watch the feed
  in-round and latch the terminal outcome at first touch).
- **60s game time-cap** — distinct from the 300s `MAX_ROUND_SECS` liveness backstop;
  the actual game round length is a Phase-2 product decision.
- **Mid-round actions** (flip / lever / partial bank) — `settle.rs` is written with
  `banked = 0` for Phase 1; the engine already supports a `banked` term for these.
- **Session keys** — `player_authority` is the owner in Phase 1; the context has a
  session-key-ready slot for delegated in-round signing later.
- **Multi-player house contention** — the single `HouseBalance` PDA is co-delegated
  per session, so two simultaneous players on the same mint would contend for the
  delegated house account on the ER. Phase 2 must decide the house topology
  (per-validator house shard, optimistic L1 house with periodic ER settlement, or a
  commit-cadence that serializes house mutations).
- **VRF crates / economy** — unchanged from the deferred design; out of Phase-1 scope.

---

## Bottom line

The full non-custodial, provably-fair on-chain round loop works today on devnet: real
USDC in, delegate → open/close settled against the live in-rollup Lazer price →
commit/undelegate → real USDC out, with a permissionless liveness backstop that
guarantees no round can escrow house capital forever. Phase 2 (intra-round liq, time
cap, actions, session keys, multi-player house topology) can build directly on this
proven lifecycle.
