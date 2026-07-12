# Perps Rider — MagicBlock Blitz v6 Submission (draft)

**Event:** MagicBlock "Blitz v6" hackathon · Mobile theme ($500 first prize) · July 10–12 2026
**Entry:** Perps Rider
**Chain:** Solana devnet · Anchor program `raider` `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`, running on a MagicBlock Ephemeral Rollup
**State:** on-chain round loop GREEN and devnet-verified end-to-end (Phase-1 + Phase-2 `RESULT.md`); native crank settlement wired and GREEN; cross-device account sync shipped; mobile shell (Seeker APK + PWA, Privy email login) built.

---

## 1. One-liner & short pitch

**One-liner (≤20 words):**

> A real perpetual-futures position you drive — a synthwave racer where price movement steers your car and liquidation wrecks you.

**Short pitch (~100 words):**

> Perps Rider is a real perp position you drive. The tachometer is a leverage dial up to 3000×; the live price of BTC, ETH or SOL pushes your car down a synthwave strip, and a liquidation is a wreck. It is not a slot machine and not a simulation — the whole round runs on-chain on a MagicBlock Ephemeral Rollup, settled in-rollup against a real Pyth Lazer price. A native crank settles continuously, so a liquidation costs the player zero transactions. Non-custodial by construction: your Privy wallet holds the stake, and anyone can recompute the payout from on-chain data.

---

## 2. Full submission description

**What it is.** Perps Rider is an arcade racer built on a real perpetual-futures position. You pick an asset (BTC, ETH, SOL) and a direction (LONG/SHORT), then set leverage by revving a tachometer that climbs to 3000× (a 1500× car on Nitro Overdrive tops out the dial). The live price drives your car: move your way to bank profit, against you past the liquidation floor and you wreck, cash out first to keep the winnings. Under the synthwave skin every beat is a genuine leveraged position on a live feed, not an animation of one.

**What runs on MagicBlock, and why it matters.** The entire round loop runs on-chain on a MagicBlock Ephemeral Rollup, not a server. The `raider` program co-delegates the player, house and round accounts into the rollup, `open`s the position against a Pyth Lazer price MagicBlock refreshes *inside* the rollup every 50–200 ms — the oracle-in-ER pattern perp DEXes use — then commits final state to Solana L1. Three properties fall out:

- **Continuous settlement, zero client transactions.** A permissionless `tick` reads the authenticated price and renders the verdict (liquidate → cap → time); the program decides the outcome, the caller only pokes it, so no operator can pick a result. A **native MagicBlock crank** (`schedule_tick` → `tick_crank`, a validator-driven `ScheduleTask` CPI) runs that settler on the rollup, so a liquidation needs no signature, no player transaction — it fires the moment the on-chain price crosses. Proven on devnet: a 2000× long crank-liquidated, payout 0, lock released, value conserved.
- **Provable fairness.** Every price the program acts on is owner- and feed-id-authenticated on-chain, and every payout is deterministic integer math anyone can recompute from the stored round. In the devnet run an independent integer mirror reproduced the payout exactly (long-100×, $60,110.50 → $60,112.90).
- **Non-custodial funds.** Stakes are wSOL in program PDA vaults; only the player's own wallet can withdraw — a non-owner withdraw is rejected by seed/owner constraints (verified on devnet). A feed registry adds ETH/SOL with no redeploy; one house pot auto-slices per-session tills for concurrent rounds.

**The mobile story (the theme).** One game, one identity, three surfaces: desktop web, an iPhone PWA (Add to Home Screen), and the Solana Seeker as a Capacitor APK. The wallet is a Privy embedded wallet made from an email one-time code — WebView-safe, so it works inside the Seeker APK — and the same login yields the same wallet everywhere. Coins, scrap and cars live on a server account keyed to that Privy identity, so your stuff follows to any device (first bind seeds from local, then server wins; deltas idempotent). A GPU-aware quality tier keeps frame-rate sane on mobile chips.

**The meta loop.** Driving earns coins and scrap. Three crate tiers — Wooden (250c/$0.99), Silver (1000c/$4.99), Gold (3000c/$9.99) — roll cars on a five-tier rarity ladder (Common → Legendary; Legendary only from Silver or Gold); duplicates melt to scrap, and crates also unlock world skins. Randomness sits behind a `RandomnessProvider` port — client RNG today, MagicBlock VRF ready to swap in. Cars carry real position mechanics: DeLorean freezes P&L ~4s, Cybertruck starts at 1500×, Orion bursts 2× leverage, Six Wheeler hauls a bigger stake, Pink Rod sets stop-loss / take-profit, Clown Car turns steering into LONG/SHORT.

**How to play (5 steps).** 1) Open the app and sign in with email — or take a walletless practice lap. 2) Drive the lobby and open a crate to unlock a car. 3) Enter the TRACK; pick an asset and a side. 4) Tap GO, rev for leverage, let the price drive you. 5) Cash out before the liquidation floor — or wreck.

---

## 3. Demo video shot list (60–90s)

Target total ≈ 82s. Two moments the video **must make legible** are marked ★ ON-CHAIN PROOF.

| # | Time | On screen | Caption line |
|---|------|-----------|--------------|
| 1 | 0:00–0:06 (6s) | Boot on the Seeker — Perps Rider splash on the actual phone. | "Perps Rider, running natively on the Solana Seeker." |
| 2 | 0:06–0:14 (8s) | Email OTP sign-in: type email → enter the 6-digit code → Privy silently creates a Solana wallet. | "One email code — Privy makes you a Solana wallet. Same login everywhere." |
| 3 | 0:14–0:24 (10s) | Drive the lobby: the car cruises the synthwave town square past Garage / Crates / Track / Highway. | "The lobby is a drivable hub — garage, crates, and the track." |
| 4 | 0:24–0:32 (8s) | Open a crate: a Gold crate cracks, a Legendary car reveals and lands in the garage. | "Crates roll cars across five rarities — VRF-ready randomness." |
| 5 | 0:32–0:38 (6s) | Enter TRACK; tap the asset (BTC) and a side (LONG). | "Pick an asset. Pick a side." |
| 6 | 0:38–0:50 (12s) | Race: tap GO, rev the tachometer toward 3000×, the live BTC price drives the car, equity/P&L ticks up. | "The tachometer IS your leverage — the real BTC price drives the car." |
| 7 | 0:50–0:58 (8s) | ★ **ON-CHAIN PROOF #1 — the settle beat.** The price crosses the floor; the car wrecks (or you cash out) with no button press. Overlay: "settled on-chain · 0 player transactions." | "Liquidation settles itself on the Ephemeral Rollup — zero transactions from you." |
| 8 | 0:58–1:08 (10s) | ★ **ON-CHAIN PROOF #2 — the balance / cash-out proof.** Wallet panel shows the wSOL/SOL balance update; a devnet round view / explorer shows the settled round and the recomputed payout. | "Non-custodial payout — recomputable by anyone from on-chain data." |
| 9 | 1:08–1:16 (8s) | Cross-device beat: the same account opened on desktop shows the same car and balance. | "One identity, one set of stuff — desktop, phone, Seeker." |
| 10 | 1:16–1:22 (6s) | End card: Perps Rider logo + program id + "Solana devnet · MagicBlock ER." | "Perps Rider — a real perp you drive. Built on MagicBlock." |

**Legibility note for the two proof shots:** Shot 7 must show the settlement happening with the player's hands off the controls (no wallet popup, no signature) — that is the zero-tx crank story. Shot 8 must show a value the viewer can trust: the wallet balance moving *and* an on-chain artifact (round account / explorer) that ties the payout to the settled round.

---

## 4. Anticipated judge Q&A

**Q: Is this gambling?**
It's a real, symmetric perpetual-futures position on a live oracle — not a house-rigged game of chance. The outcome is decided by public BTC/ETH/SOL price movement; the settlement math is deterministic integer arithmetic recomputable by anyone from on-chain data; and there's a genuine skill layer (entry, direction, leverage, when to cash out, plus car abilities like stop-loss / take-profit). The demo runs on devnet with no real money. Mainnet real-money is a later, gated pillar with its own payment rail and jurisdiction legal read — deliberately out of scope for this submission.

**Q: Why an Ephemeral Rollup instead of settling on L1?**
The round is a live, per-tick state machine. At up to 3000× a ~0.05% move can liquidate, and we settle continuously against a price refreshed every 50–200 ms — that cadence and cost are not viable on base-layer Solana. The ER gives near-free ticks and sub-400 ms warm settles (measured on devnet, `RESULT.md`) while still reading an authentic in-rollup Pyth Lazer price and committing final state back to L1. We get arcade speed without giving up L1 finality or provability.

**Q: What is actually decentralized / non-custodial?**
Funds: stakes are wSOL in program PDA vaults, and only the player's own wallet can withdraw — a non-owner withdraw is rejected by the program's seed/owner constraints (verified on devnet). Settlement: the program reads an owner- and feed-id-pinned Pyth Lazer price and renders the verdict itself, so no operator — including us — can choose an outcome. What is *not* decentralized yet, stated plainly: the crank/keeper is operator-run (but permissionless and outcome-blind — it can only poke `tick`, never pick a result), and the collectible/account layer is a server (next answer).

**Q: How do you stop a tampered client from minting rewards?**
Two separate trust domains. Money — stakes and payouts — never takes the client's word: it's the on-chain round, where the program computes the payout from an authenticated price. The soft economy (coins/scrap/cars) is a server-authoritative ledger where the client sends **idempotent deltas** ("earned N"), never absolute balances, so a hacked client can't set its own balance and a replayed race can't double-credit; on reconcile the server wins. A tampered client can lie to itself locally, but it cannot mint on-chain value or persist a forged balance.

**Q: How is this different from a perp DEX (e.g. FlashTrade)?**
Same on-chain machinery — ER settlement, Pyth Lazer, PDA custody — but the product is a game, not a pro terminal. The position is expressed as driving, leverage is a rev, risk management is car abilities, and a crate/rarity/scrap meta-loop plus a drivable lobby wrap it. It's a perp for people who would never open a DEX.

**Q: What's next?**
Swap the `RandomnessProvider` port from client RNG to MagicBlock VRF for provable crate odds; make cars/crates tradable NFTs (the one pillar that genuinely needs chain, for ownership); and the mainnet real-money cutover behind the payment rail and legal read. The seams for all three already exist (VRF port, counted inventory, wSOL stake path).

---

## 5. Submission-form checklist

- **Repo link:** `<REPO_URL>`
- **Demo video link:** `<VIDEO_URL>` (60–90s; follow the shot list in §3)
- **Deployed web URL:** `<WEB_URL>` (desktop web + iPhone PWA via Add to Home Screen)
- **APK distribution:** side-load via the LAN route — from `redline3d/`, `npm run apk:serve` builds and serves `redline.apk` at `http://<host-ip>:8077/redline.apk`; on the Seeker, open that URL in Chrome → Download → allow "install unknown apps" → Install. Build requires **JDK 21** (not 17). The Solana dApp Store is the later listed-distribution path.
- **On-chain proof:** program `raider` `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv` on Solana devnet (MagicBlock Ephemeral Rollup); Phase-1/Phase-2 `RESULT.md` in `onchain/raider/`.
- **Network:** Solana devnet — no real money in this submission.
- **Tech tags:** Solana · MagicBlock Ephemeral Rollup · Pyth Lazer · Privy · Capacitor · Three.js.
- **Team / contact:** `<TEAM_NAME>` · `<CONTACT_EMAIL_OR_HANDLE>`

---

*Draft — facts sourced from the repo's `docs/superpowers/specs/*` and `onchain/raider/` (program + `RESULT.md`) as of 2026-07-08. Placeholders in angle brackets are for the submitter to fill.*
