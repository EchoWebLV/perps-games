# Phase 0 Spike Result — 2026-06-27

**Verdict: 🟢 GREEN — proceed to Phase 1.** A custom Anchor program was deployed to
Solana devnet, delegated to the MagicBlock Ephemeral Rollup, read the live Pyth
Lazer BTC/USD price *inside the rollup* (matching Binance to ~0.1%), and
committed/undelegated its state back to L1 — all proven by a passing driver
(`tests/lazer-probe.ts`, 5/5 passing).

## Assumption verdicts

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| 1 | A custom program can delegate to the devnet ER | ✅ PASS | Probe owner flipped to delegation program `DELeGG…` in ~1s |
| 2 | It reads the **live** Lazer BTC price inside the ER | ✅ PASS | $60,536 on-chain vs $60,631 Binance (0.16%); `publish_time` advanced on **40/40** samples |
| 3 | Commit + undelegate round-trips to L1 | ✅ PASS | final `last_price` readable on base devnet, owner restored to program |
| 4 | ER round-trip latency | ⚠️ MEASURED 1448ms (not the ~150ms target) | see "latency caveat" below — measurement methodology, not an ER speed limit |

## What ran (reproducible)

- **Program:** `A1JfNBqRKHmrU5XuHP1vHNKoQfhEqR25MtWvdD6u8dbV` (deployed to devnet, upgrade authority = spike wallet).
- **Probe PDA:** `55Z6vb5CKEVG3LFWsaMBNsHtTf1mfvvyLXCZrfXpn6ar` (seeds `[b"probe"]`).
- **ER endpoint:** `https://devnet.magicblock.app` (validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`).
- **Lazer BTC/USD feed:** `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` (owner `PriCems5…`, 134 bytes).
- **Run:** `ANCHOR_WALLET=~/.config/solana/lazer-probe.json npx ts-mocha -p ./tsconfig.json -t 1000000 tests/lazer-probe.ts`
- **Latency:** median **1448ms**, min ~1415ms, max ~2120ms over 40 confirmed `.rpc()` round-trips.

## Winning dependency trio (the front-loaded risk)

- `anchor-lang = "0.32.1"` (init-if-needed)
- `ephemeral-rollups-sdk = "0.15.5"` (feature `anchor-compat`) — delegation API = `delegate_pda` + `MagicIntentBundleBuilder::new(...).commit_and_undelegate(...)`.
- **`pyth-solana-receiver-sdk` EXCLUDED.** It conflicts with ers-sdk 0.15.5 over `bytemuck_derive` (via the `pythnet-sdk` transitive dep). Worked around by hand-decoding the `PriceUpdateV2` account bytes on-chain (the layout is stable; offsets verified against the live account).
- Built with `~/.avm/bin/anchor-0.32.1 build`. **Gotcha:** the stale scaffold `Cargo.lock` pinned anchor-lang 0.31.1 and broke `anchor-compat`; deleting the lock let cargo unify on 0.32.1.

## Findings to carry into Phase 1

1. **Lazer-on-ER exponent is a POSITIVE magnitude.** USD = `price * 10^(-expo)` (here expo = `8`). This is the opposite sign of the standard Pyth pull-oracle. The settlement program must apply this convention. (Raw `6053646533209`, expo `8` → $60,536.)
2. **Pyth SDK vs ers-sdk conflict is unresolved.** Either (a) keep a small hand-rolled `PriceUpdateV2` decoder (proven here), or (b) find a `pyth-solana-receiver-sdk` / ers-sdk version pair that resolves `bytemuck_derive`. The spike chose (a). Note the hand decoder dropped `get_price_no_older_than` freshness validation — Phase 1 should re-add an on-chain staleness check (the spike proved liveness via the advancing timestamp instead).
3. **Latency caveat — measure properly before trusting any number.** 1448ms is the *full client-observed* `.rpc()` round-trip at `confirmed` commitment, over the public internet from a laptop. It is NOT MagicBlock's ~50ms on-validator execution figure. Phase 1 should measure with `processed` commitment + a websocket account subscription (the way a real client would render optimistically), and ideally from a closer region. Do not assume the game feels 1.4s-laggy from this.
4. **No registration/whitelisting needed.** Deploying a custom program to devnet + delegating to the public ER `MAS1Dt9…` worked with no MagicBlock signup or auth header. The auth header in the pricing-oracle README is only for *running a price pusher*, which we don't need (MagicBlock already serves the example feeds).
5. **Endpoint/validator pairing is trivial on devnet.** `devnet.magicblock.app` and `devnet-as.magicblock.app` both report the same validator `MAS1Dt9…` and both serve the feed; delegating to that validator co-locates the Probe with the feed.
6. **Delegation + commit/undelegate were fast and reliable** (owner flip ~1s; undelegate finalized well under the 60s budget). The `#[ephemeral]` macro also generates a `process_undelegation` callback the delegation program invokes automatically.

## Bottom line

The technical foundation for the full-on-chain ER architecture (Approach C) is real
and works today on devnet. Phase 1 (core on-chain round: PlayerVault + HouseVault +
Round, deposit/withdraw, open/close settled against the ER Lazer price) can build
directly on this proven delegate → act-on-ER → commit/undelegate lifecycle.
