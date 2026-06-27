# Wallet / Custody / Onboarding / Money-Flow Decision Report
### For a non-custodial, provably-fair perps-arcade on Solana + MagicBlock Ephemeral Rollup

**Date:** 2026-06-27
**Branch context:** `onchain-er-rebuild` — Phase-0 Lazer spike already GREEN on devnet (`spikes/lazer-probe/`)

**The two locked drivers everything is judged against:**
1. **Non-custodial funds** — only the user's real wallet can move their money out.
2. **Provable fairness** — outcomes decided by a public, un-grindable source.

**The intended flow we're validating:** connect/embedded wallet → one buy-in per session → a scoped session key auto-signs fast ER rounds → cash out, withdraw gated to the real wallet only.

---

## EXECUTIVE SUMMARY — the 7 things the founder most needs to know

1. **Your intended flow is the convergent industry pattern, already shipping in production.** Master wallet = sole withdrawer + a scoped, expiring, trade-only signer that auto-signs the fast loop = exactly how Hyperliquid (agent wallets), pvp.trade, dYdX v4, and every MagicBlock game (Supersize/Slimecoin) work. You are not inventing a money/signing model — you are cloning a proven one and swapping the game (a real 2000× perp) and the settlement source (Pyth Lazer in-rollup). Don't over-engineer this.

2. **The custody-vs-Privy-vs-alternatives verdict: NEITHER custodial NOR an embedded provider in the core path. Connect the user's existing self-custody wallet.** This is the single biggest correction to the original analysis. The strongest, most non-custodial answer — and the one **already approved in your own on-disk spec** (`docs/superpowers/specs/2026-06-25-privy-removal-wallet-adapter-design.md`) — is to connect the wallet the user already has via **Solana Wallet Standard (web)** and **Mobile Wallet Adapter / Seed Vault (Seeker)**. The dApp never touches the private key. No embedded provider, no custody ambiguity, no vendor lock-in. Privy and Turnkey are demoted to an **optional fallback** for the one real gap: non-crypto web visitors with no wallet at all.

3. **The "Privy is janky" problem is mis-diagnosed — it's not a wallet-vendor problem, it's a per-tx-signing problem that the session key removes entirely.** The jank is per-action Solana embedded signing. Once a **MagicBlock session key** carries the round loop, the real wallet signs **once** (buy-in + session creation) and **once** (cash-out), and the fast rounds are auto-signed by a scoped ephemeral key with zero popups. The "which wallet" question is decoupled from "what signs each round." So the fix is **architecture, not a vendor swap.**

4. **Non-custodial is necessary but NOT sufficient — fairness is a separate, harder driver, and it's where the closest competitors are weakest.** Luck.io was non-custodial and still died because its randomness was grindable off-chain. Your structural advantage: outcomes are decided by a **signed Pyth Lazer price read inside the rollup** — a public, externally-attested feed the operator cannot regrind. You must be able to point at the **Lazer signature** as the proof. The real-perp front-ends (pvp.trade, Moonshot) are non-custodial but **not** provably fair (closed-source enclave execution); the arcade incumbents (Rollbit, Banana Zone) are custodial/synthetic-house-vault. Non-custodial **and** provably fair on a **real** on-chain perp is genuine whitespace.

5. **The house-vault counterparty is the real net-new Phase-1 work — and it's buildable today.** "Clone Supersize" is right about onboarding + vault-delegation UX but **wrong about money topology**: Supersize is symmetric (player-vs-player); a 2000× perp is asymmetric (the house can owe 2000× a player's stake). The answer is **not** a Flash-Trade-style resolver or a Jupiter-JLP-style pooled LP (both reintroduce trust/insolvency surfaces — Hyperliquid's HLP was drained 3× in 2025). The answer is a **second co-delegated, program-owned house-escrow PDA with per-round max-payout pre-lock**: at round-open the program reserves the maximum the round can pay before accepting the position, so the house is **provably solvent by construction**. MagicBlock's `ephemeral-rollups-spl` ships the exact instruction set (`token_escrow_transfer` between two escrows inside the rollup).

6. **Two un-closed trust gaps must be designed around BEFORE real money — both are liveness/keeper, not custody.** (a) **Client-observed ER latency is UNMEASURED for our case.** MagicBlock's "<50ms" is a co-located, validator-side figure; our own Phase-0 spike measured **1448ms median** — but that was worst-case-configured (hardcoded Asia validator, `confirmed` commitment, blocking `.rpc()`, no optimistic render). Real arcade feel is achievable but is a **client-rendering problem we must solve and measure**, not a settled number. (b) **Only the operator's validator can settle/undelegate state to L1** (confirmed in `delegation-program` source: `require_signer(validator)`, no timeout). A stalled validator freezes a player's PnL in a delegated PDA. The fix is a **permissionless, time-bounded `forceCloseRound`** in *our* program + on-chain price-staleness bounds.

7. **Non-custodial does NOT settle the legal/licensing question, and distribution is constrained.** "Non-custodial therefore no gambling license" is legally untested — Curaçao/Anjouan frameworks assume operator custody and say nothing about non-custodial play. Combined with the Apple/Google reality (Moonshot was delisted over 250× leverage), this confirms the existing plan: ship real money via **web/PWA + Solana dApp Store**, keep a scrubbed soft-coin build for mainstream stores. Treat licensing as a separate legal read.

**One-line architecture:** `connect existing wallet (Wallet Standard / MWA / Seed Vault)` + `one buy-in → program-owned vault PDA delegated to the ER` + `MagicBlock session key auto-signs rounds` + `signed Pyth Lazer in-rollup decides outcomes` + `co-delegated house-escrow PDA with max-payout pre-lock` + `permissionless forceCloseRound + price-staleness bounds for liveness` + `commit/undelegate → withdraw, gated to the real wallet only`.

---

## 1. Custodial vs non-custodial landscape — who's which, why, and the verdict

**The decisive definition (settles the "does a wallet-per-user mean custody?" worry):** Custody is defined by **who can unilaterally sign/move funds**, not by who triggers wallet creation. Every embedded-wallet provider provisions a wallet per user while staying non-custodial — via TEE enclaves (Privy, Turnkey, Coinbase CDP, Magic) or MPC/TSS share-splitting (Web3Auth, Dynamic, Para, Particle) where the full key is never assembled in one place. **Custody only appears if (a) one party holds enough shares to sign alone, or (b) you adopt delegated server-signing where your backend can sign withdrawals.** So non-custodial is achievable off-the-shelf; the trap is the *signing model you bolt on*, not the wallet-per-user itself.

**But the strongest non-custodial answer skips the embedded provider entirely:** connect the user's **existing self-custody wallet** (Phantom/Backpack/Solflare on web via Solana Wallet Standard; Seed Vault/any MWA wallet on Seeker). Then there is no embedded key, no provider-managed share location, no "who holds enough shares" question, and no vendor lock-in. The dApp never receives the private key — signing happens inside the wallet app. This is strictly more non-custodial than any embedded candidate. https://solana.com/solana-wallets · https://www.helius.dev/blog/solana-smart-wallets

**Who is which, and why:**

| Category | Who | Why they're that way |
|---|---|---|
| **Custodial (operator holds funds)** | Stake, Rollbit, Shuffle, BC.game, Roobet, Telegram bots (BONKbot/Trojan/Maestro server-key variants) | Deposits sit in an operator-held internal balance; bets are off-chain ledger entries. Custody is a **regulatory/UX choice, not a technical one** — and it produces hot-wallet honeypots (Roobet ~$16.8M in one identifiable wallet on Etherscan; BC.game lost ~$4.3M to a third-party-game exploit draining custodial funds). https://etherscan.io/address/0xc94ebb328ac25b95db0e0aa968371885fa516215 · https://www.vip-grinders.com/news/bcgame-hacked-4-3m-stolen/ |
| **Non-custodial via two-key split** (the perps norm) | Hyperliquid (master + agent), dYdX v4 (derived chain key), Lighter/Aevo (API key), pvp.trade (Turnkey enclave + HL agent) | A **master wallet = sole withdrawer**, plus a **scoped, expiring, trade-only signer** that auto-signs the fast loop and provably cannot withdraw. This is the convergent answer and **your design sits squarely on it.** https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets |
| **Non-custodial via program/smart-contract custody** (the Solana norm) | Drift, Zeta, Jupiter Perps, Flash Trade, Solpump, Azuro, **Supersize/Slimecoin on MagicBlock** | Funds live in a program-owned PDA the operator can't unilaterally move; user retains withdraw authority. Supersize states it outright: *"neither Supersize nor MagicBlock ever takes control of funds."* https://www.magicblock.xyz/blog/slimecoin |
| **Most non-custodial: connect existing self-custody wallet** | Drift/Jupiter/Flash Trade front-ends; any Solana dApp using Wallet Standard / MWA / Seed Vault | No embedded key at all — the user already holds their keys (Phantom/Backpack on web; hardware TEE on Seeker). Zero provider custody surface. **Your approved direction.** https://docs.solanamobile.com/developers/seed-vault |
| **Custodial-by-bridge (a subtle compromise)** | Hyperliquid's funds-at-rest | HL trading is non-custodial in spirit, but deposits actually sit in a **validator-multisig Arbitrum bridge** (4 hot + 4 cold foundation validators). A custody compromise we can and should avoid. https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/bridge |

**The cautionary tales that shape our two drivers:**
- **Luck.io** (Solana casino, shut down Apr 2026) was "non-custodial" but **still died on fairness** because its VRF was generated *off-chain* — foobar's critique: *"you can keep regenerating VRFs until you get a result you like, then publish it."* **Lesson: non-custodial is necessary but NOT sufficient.** https://www.cryptopolitan.com/exposed-solanas-casino-luck-io-is-shutting-down-urges-players-to-withdraw-funds-asap/
- **Solareum** (2024) drained ~$523K across 113 Telegram bots — root cause was users holding a **single exportable private key** floating between custodial-ish bots. Lesson: a hot signer is fine **only if scoped (can't withdraw) and ideally never a single exportable server secret.** https://decrypt.co/224371/solana-telegram-trading-bot-shut-down-users-drained-523k

**Verdict for us:** Go non-custodial via the user's **own connected wallet + a program-owned vault PDA** (the Solana/Supersize model), **not** a validator bridge (HL's compromise), **not** a pooled-collateral resolver (Flash Trade's model — it reintroduces a "resolver can access your assets" trust surface), and **not** an embedded provider in the core path (it adds a custody/trust surface to users who already self-custody). Our fairness proof is **structurally stronger than every commit-reveal casino**: outcomes are decided by a **signed Pyth Lazer price read inside the rollup** — a public, externally-attested feed the operator cannot regrind. That combination — non-custodial *and* provably fair on a *real* on-chain perp — is the whitespace.

---

## 2. Wallet provider comparison — the missing fourth option, then the embedded field

**The framing correction:** The decision is **not** "Privy vs Turnkey vs some other embedded provider." It is **"connect the user's existing wallet (the approved, most-non-custodial answer) vs, only as a fallback, an embedded provider for wallet-less web visitors."** Your own on-disk spec mandates this: `docs/superpowers/specs/2026-06-25-privy-removal-wallet-adapter-design.md` states verbatim *"Use Solana Wallet Standard / Solana Wallet Adapter… Do not replace Privy with another embedded wallet provider in the core app shell."* The table below leads with that fourth option.

### 2a. Connect-existing-wallet transports (the recommended core path)

| Transport | Surface | Custody | Per-action jank | Notes |
|---|---|---|---|---|
| **Solana Wallet Standard** | Web | Self-custody (key never leaves wallet) | Per-tx popup for fund/withdraw only | One-click Connect → pick Phantom/Backpack/Solflare. Real Solana users already have one. **Gap:** a true non-crypto web visitor with no wallet hits a wall — the *only* place an embedded fallback earns its keep. https://solana.com/solana-wallets |
| **Mobile Wallet Adapter (MWA)** | Seeker / Android | Self-custody | Per-tx popup; `authorize()` once + `reauthorize()` avoids re-connecting | `signTransactions`/`signAndSendTransactions` run inside the wallet; secret key never exposed. Android-only (no iOS). https://docs.solanamobile.com/developers/mobile-wallet-adapter |
| **Seed Vault Wallet** | Seeker hardware | Self-custody, **hardware TEE / secure element** | Per-tx biometric approval at hardware level | Strongest non-custodial substrate available — keys never leave the vault even if Android is compromised. Reached over MWA, so it slots behind the same wallet abstraction. https://docs.solanamobile.com/developers/seed-vault |

Per MEMORY the product targets **Seeker**, where users **already** hold Seed Vault (hardware self-custody). Putting an embedded provider in front of them is redundant and *adds* trust surface.

### 2b. Embedded providers (relevant only as an optional, wallet-less-web fallback)

| Provider | Custody | Solana maturity | Session/auto-sign support | Jank reputation | Who uses it |
|---|---|---|---|---|---|
| **Privy** (Stripe-owned) | Non-custodial, 2-of-2 Shamir + TEE; user-exportable | High volume but **EOA-only, Solana secondary to EVM** | Yes — session signers / delegated actions + can disable confirmation modals | **The complaint** — default per-tx iframe modal is the founder's pain; Privy's own docs admit the "high UX cost". Fixable via config. **Your spec REMOVES it.** | pump.fun, Hyperliquid, OpenSea, Vector |
| **Turnkey** | Non-custodial, AWS Nitro TEE, raw key never leaves enclave; remote attestation | High — native Ed25519, ~100–150ms signing | Strongest — scoped time-bound sessions + in-enclave **Solana Policy Engine** (program/amount/address allowlists) | Smooth — the stack behind the *less-janky* experiences | **pvp.trade, Moonshot** |
| **Crossmint** | **Configurable** (custodial OR non-custodial) — must pin | Native Solana **smart-contract wallets** (unique here) | On-chain session keys + spend limits enforced in the wallet contract | Untested at our latency; proprietary/closed | Onramp-heavy consumer apps |
| **Dynamic** (Fireblocks) | Non-custodial TSS-MPC + TEE | Medium — EdDSA via FROST; embedded TSS was beta | Session mgmt + JWT; delegated server-signing "less developed" | MPC ceremony adds a round-trip vs TEE | Multi-wallet aggregator apps |
| **Para** (ex-Capsule) | Non-custodial 2-of-2 MPC + passkey in secure enclave | Recent Solana MPC support | Yes — passkey unlocks a scoped session over the Ed25519 key | Slick biometric UX; **HSM throughput flagged "hard to scale"** | Passkey-first mobile apps |
| **Phantom Embedded** | Non-custodial (Phantom self-custody) | **Highest brand trust on Solana**, native | No documented session-key path; built-in $1k/day cap + domain binding | Per-tx popup by default; SDK "in active development" | Phantom ecosystem |
| **Coinbase CDP** | Non-custodial TEE enclave | Solana **EOA-only** | No highlighted session primitive | Trust + native fiat onramp, not signing | Coinbase-brand consumer |
| **Web3Auth** (MetaMask Embedded) | Non-custodial MPC (Shamir) | EOA-only | None native | MPC ceremony latency; cheapest per-MAU | Social-login front doors |
| **Magic.link** | Non-custodial TEE (TKMS/DKMS) | One of 30+ chains, not a focus | None game-grade | Enterprise/brand-loyalty infra | Mattel, Macy's, Immutable |
| **Particle** | Non-custodial MPC-TSS | **Thin on Solana** (AA is EVM/7702-centric) | AA session keys (EVM); don't map to Solana | Chain-abstraction is noise for us | EVM-first |

Sources: https://privy.io/blog/how-privy-embedded-wallets-work · https://docs.privy.io/guide/delegated-actions/usage/solana · https://www.turnkey.com/blog/introducing-solana-policy-engine · https://www.turnkey.com/blog/best-solana-wallets-dapp-developers · https://www.crossmint.com/learn/privy-alternatives-for-programmable-wallets · https://blog.getpara.com/solana-passkeys/ · https://docs.phantom.com/phantom-connect · https://www.helius.dev/blog/solana-smart-wallets

**"Is there a less-janky alternative to Privy that still gives non-custodial wallet-per-user UX?"**

The honest answer is **the question is slightly wrong.** Two things resolve it:

1. **The jank is per-tx Solana embedded signing, which the correct architecture removes entirely.** Once a MagicBlock session key carries the round loop, the wallet signs **once** (buy-in + session creation) and **once** (cash-out). So "less janky than Privy" is solved by *architecture*, not by *switching vendors*.

2. **The most non-custodial answer is to not use an embedded provider in the core path at all** — connect the wallet the user already has. This also matches your approved spec and removes the entire embedded-jank debate.

**Where embedded providers still have a (demoted) role:** an **optional, dynamically-imported fallback** for non-crypto web visitors with no wallet — never in the app shell, never on the GO!/round path, never holding withdrawal authority. If you do add one:
- **Turnkey** is the top embedded pick — native Ed25519, an in-enclave **Solana Policy Engine** ("this session key may only call our program, never withdraw"), and a track record in *our* genre (pvp.trade, Moonshot). Trade-off: you build more login UX.
- **Phantom Embedded** is the best *login* for a Solana-native audience (instant Google/Apple) but **has no session-key path**, so pair it with MagicBlock session keys.
- **Crossmint** is the only one with on-chain (contract-enforced) session limits, but it's configurably custodial (pin it) and unproven at our latency.

A note on **Turnkey-style server signing for the fee-payer slot:** if you sponsor deposit gas, the server signs **only the fee-payer**, never the user's authority. That's a legitimate, non-custodial-of-user-funds use — don't conflate it with a user-wallet provider.

**Bottom line for Section 2:** Primary recommendation = **connect existing wallet (Wallet Standard on web, MWA/Seed Vault on Seeker) + MagicBlock session keys for the round loop.** Embedded providers (Turnkey > Privy) are a clearly-labeled optional onboarding fallback only. This reconciles with the approved removal spec and is strictly more non-custodial than the original "keep Privy, run a bake-off" recommendation.

---

## 3. Session keys / gasless signing — the canonical 2026 pattern AND the actual jank-killer

**This is the centerpiece. It is what actually kills per-action signing jank — not the wallet choice.** The original analysis mis-attributed the jank to the wallet vendor; the real fix is the session key on the ER, which works behind **any** connected wallet.

**There are TWO different frictions and you need BOTH primitives:**

- **MagicBlock ER delegation** (`delegate_account` / `commit_and_undelegate_accounts`) removes **network friction** — fast in-rollup settlement, single-point RPC auto-routing, no bridge/token. **But every in-rollup tx still needs a signature.**
- **Session keys** remove the **wallet-popup friction.**

Delegation alone = fast popups. Session keys alone = slow silent txs. **You want delegation + session key = silent AND fast.** Supersize.gg is the production proof of the combo. https://docs.magicblock.gg/pages/tools/session-keys/introduction

**The exact founder flow, confirmed in MagicBlock's docs:** the connected main wallet (Phantom/Backpack/Seed Vault — **does not need to be embedded**) performs **one signature** to create and fund a scoped session token. A random keypair is generated client-side (`web3.Keypair.generate()`), encrypted, and stored in the browser (IndexedDB). After that single approval the ephemeral key auto-signs the fast rounds on the ER with **no popups**. The main wallet "retains control as a normal connected wallet," and the "session key operates with a delegated, limited amount, while the bulk of the user's funds remain secure in their primary wallet." Scope is set at the contract level: **expiry/duration, max tokens spent, max number of transactions**, and a tiny gas top-up (docs cite ~0.01 SOL as the worst-case exposure). Keys are revocable and expiring. https://docs.magicblock.gg/pages/tools/session-keys/security · https://www.magicblock.xyz/blog/the-ephemeral-rollup-effect

**The canonical primitive — MagicBlock's `gpl_session` program** (`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`):

- On-chain `SessionToken` PDA stores exactly `{ authority, target_program, session_signer, valid_until }`, seeds `[target_program, session_signer, authority]`.
- **Real wallet signs ONE `create_session` tx** (both `authority` and `session_signer` sign at creation; optional `top_up=true` seeds the ephemeral key ~0.01 SOL for its own fees). After that, the **client-side ephemeral keypair auto-signs every fast round locally with zero popups.**
- Default validity **1 hour**, **hard-capped at 7 days**. `revoke_session` kills it instantly and refunds rent.
- Verified from source: `create_session` requires **both** `session_signer` AND `authority` as Signers; the current Anchor example imports `SessionTokenV2`.

https://github.com/magicblock-labs/session-keys · https://docs.magicblock.gg/pages/tools/session-keys/how-do-session-keys-work

**How it kills the per-action jank, concretely:** Guard your hot round instruction with `#[session(signer = payer, authority = vault.authority)]` and `#[session_auth_or(<owner-check>, SessionError::InvalidToken)]` so **either** the owner **or** a valid session token authorizes a round. Drop your perp round-settlement instruction where the example's `increment` sits → **signature-free 2000× rounds.** Leave `deposit`/`delegate`/`withdraw` **owner-only**.

**The critical caveat — the Solana session token is THINNER than EVM smart-sessions (Rhinestone/ZeroDev) and you must NOT over-trust it.** It enforces only **program-scope + expiry**. There is **no built-in per-instruction allowlist and (in the on-chain token itself) no enforced spend cap.** "Session keys can't touch funds" is **true only if you enforce it in your program.** So:
- Gate **which instructions** accept session-token auth (method allowlist — hand-rolled).
- Make `withdraw` require the **real authority as a plain Anchor `Signer`** that is *never* satisfiable by a session token.
- Given 2000× leverage, **bake an explicit max-cumulative-stake-per-session into the session guard** (steal the EVM smart-session policy taxonomy: method allowlist + spend cap + expiry). This is **load-bearing, not optional.**

**Two real gotchas from the official code:**
- After the delegate CPI transfers PDA ownership to the Delegation Program, you must read `authority` from raw account data via `UncheckedAccount` and do the session check manually — otherwise Anchor re-serializes stale data and fails.
- `deposit`/`withdraw` are **L1-only** (they touch a real token account, which can't live in the ER). Only the lightweight balance settlement runs in the ER.

**Avoid the anti-pattern:** A naive **burner keypair** has no on-chain scope/expiry and can sign anything — and Solana's own auto-approve guide explicitly recommends session keys over burners. Keep the player's buy-in in a program-owned vault PDA; `top_up` the session key with **dust for fees only, never the stake.** https://solana.com/developers/guides/advanced/auto-approve

---

## 4. How comparable products do it — who-does-what matrix

| Product | Custody | Onboarding | Signing model | Money flow | Relevance |
|---|---|---|---|---|---|
| **Hyperliquid** ⭐ | Non-custodial trading; funds-at-rest in validator bridge | Connect EVM + 2 sigs (enable + ApproveAgent) | **Agent/API wallet** — one ApproveAgent sig, then trade-only key auto-signs; 180-day cap, revocable, replay-protected; **cannot withdraw** | Deposit-to-bridge → trade → withdraw via master only | **THE precedent. Copy the four agent guarantees.** |
| **pvp.trade** ⭐ | Non-custodial, key in **Turnkey enclaves**, user-exportable | Open Telegram → wallet auto-spun | Enclave + HL agent signs trades server-side; biometric passkey 2FA | Deposit ≥10 USDC → trade → **`/withdraw` only to a wallet you own on HL** | **Closest shipped match to our spec.** Uses Turnkey, not Privy. |
| **dYdX v4** | Non-custodial (Cosmos app-chain) | Sign once → derives chain key | **Derived session key**; orders off-chain/gasless, settle on match | Deposit collateral → gasless orders → withdraw | Validates sign-once-then-auto-sign |
| **Lighter / Aevo** | Non-custodial (zk-rollup / L2) | One "enable trading" sig | **API key** signs gasless off-chain orders | Deposit → gasless orders → settle → withdraw | 2 more independent confirmations of the agent/session pattern |
| **Drift / Jupiter / Flash Trade (Solana)** | Non-custodial, program-owned margin account | **Connect existing Phantom/Backpack** | **Per-tx wallet popup** (speed from cheap L1) | Direct-wallet → deposit collateral → trade | **The baseline we beat** — connect-wallet is right, but they don't solve per-action jank |
| **Pacifica (Solana)** | Non-custodial on-chain settlement | Connect, no KYC | Off-chain matching engine + on-chain settle (signing model unverified) | Deposit → fast off-chain order path | **#1 Solana perp by volume** — validates "CEX-fast + non-custodial settle" |
| **Zeta / Zeta X** | Non-custodial smart-contract custody | Connect + deposit; OAuth+fiat on roadmap | Per-tx today; **building its own Solana L2** | Deposit-to-program → cross-margin | **Strong validation of the rollup bet** — a serious team independently chose a rollup for speed-vs-self-custody |
| **Supersize / Slimecoin (MagicBlock)** ⭐ | **Non-custodial player-owned vault** | "Hit start, feels like a normal .io game"; single-point RPC hides rollup | **Session key + delegation = gasless real-time** | Activate vault (deposit+delegate) → ER play → undelegate-to-withdraw → redeposit redelegates | **Near-exact precedent for ONBOARDING + vault UX. But symmetric money topology — see §6.** |
| **Flash Trade on ER** | Non-custodial, **pooled collateral + resolver** | CEX-like | Signed orders → resolver executes; sub-50ms ER; **Pyth Lazer in-ER for liquidation** | Deposit to pooled margin → trade | **Proof real perps run on ER non-custodially — but DON'T copy the pooled/resolver model.** Liquidation-keeper identity not publicly documented. |
| **Rollbit** | **Custodial** | Account + deposit, instant | Server-signed (synthetic, house is counterparty/oracle) | Custodial balance | The **UX feel** benchmark (1000×, max-loss=stake, no liq cascade) — reject its custody + house-oracle |
| **Banana Zone** | Synthetic house-vault (custody unverified, site 403'd) | Game-first, "makes sense in 30 min" | Tap-to-bet (unverified) | Synthetic bet | **Closest stated competitor** — we out-position on both drivers (they're a house-vault, not a real on-chain perp) |
| **Moonshot** | Non-custodial **Turnkey** MPC | Email/Face ID + Apple Pay → trading in minutes | Enclave signing; trades on Jupiter Perps | Fiat on-ramp → self-custody wallet → real perps | **Mainstream-grade onboarding bar.** Also the **distribution red flag:** Apple **delisted** it over unlicensed 250× leverage. |
| **Polymarket** ⭐ | Non-custodial **user-owned proxy/Safe** | Magic email login → non-custodial wallet, no seed | **EIP-712 sig + relayer pays gas**; ERC-1271 order validation | Funds stay in user proxy; relayer gasless; withdraw to EOA | **Onboarding blueprint** — web2 UX + self-custody |
| **Solpump (Solana)** | Non-custodial, **wallet = bankroll** | Connect, bet in seconds | **Signature PER BET** (no session keys) | Direct-wallet, contract pays winners | **Our model minus the two things we add** — proves demand, shows the friction we remove |

⭐ = closest precedents.

**The closest precedent, called out: Hyperliquid agent wallets.** Adopt its **four guarantees verbatim** — the auto-signing key is (1) **trade-only** (structurally cannot withdraw), (2) **expiring** (hard TTL), (3) **revocable**, (4) **replay-protected** (per-signer nonces). Map line-for-line: master wallet → real connected wallet (sole withdrawer); agent → MagicBlock session key (signs ER rounds). **Two improvements over HL for our stack:** (a) avoid HL's validator-bridge custody — keep funds in a *program-owned* vault; (b) MagicBlock enforces session scope **at the contract level**, so a leaked session key is bounded by on-chain limits, not just "can't withdraw" — strictly better than HL's localStorage agent key. Note the HL **replay-after-nonce-pruning** gotcha and design session nonce/expiry hygiene accordingly.

---

## 5. Onboarding UX best practices 2026 — what "<30s to first play" actually looks like

**The winning sequence (connect-wallet-first, embedded only as fallback):**
1. **For the Solana-native majority (and all Seeker users):** one-click **Connect existing wallet** (Wallet Standard on web; MWA/Seed Vault on Seeker). No email, no OTP, no provisioning. This is the default.
2. **For the no-wallet web visitor (the only gap):** social or biometric login → optional embedded wallet, **no seed phrase** — *or* a passkey/Wallet-Standard-only onboarding. Weigh passkey-first before adding any embedded provider.
3. **(If no crypto)** embedded **Apple Pay / card on-ramp** (MoonPay, Stripe Onramp, Coinbase Onramp — all support USDC + SOL on Solana; MoonPay is already embedded inside Hyperliquid) drops the USDC buy-in straight into the user's wallet.
4. **Approve one session key** (bundled with the buy-in + delegate in a single batched tx).
5. **Auto-signed ER rounds** — zero popups.

https://docs.stripe.com/crypto/onramp · https://www.moonpay.com/business/ramps · https://docs.privy.io/wallets/funding/fiat-onramp

**Hard truths:**
- **The one unavoidable friction spike is on-ramp KYC.** Let crypto-native users fund from an existing wallet/exchange to skip it; treat fiat on-ramp as the no-crypto fallback. Don't put KYC on the critical path for users who already hold USDC.
- **Passkeys are an *authorization* primitive on Solana, NOT a transaction signer** — WebAuthn passkeys are P-256; Solana txs need Ed25519, and browsers don't expose Ed25519 in secure enclaves. So Para/Coinbase Smart Wallet use the passkey to *unlock a scoped session* that drives an Ed25519 key. That "passkey → scoped session → signer" shape **is the same shape as your buy-in → session-key → round-signer** — lean into it. https://blog.getpara.com/solana-passkeys/
- **Coinbase Smart Wallet** sets the absolute UX gold standard (one biometric tap, no install, no seed, free) but is **Base/EVM-only** — use it as the *bar*, not as infrastructure.
- **Telegram TON** is the lowest-friction *distribution* in crypto, but **TON-exclusive** for Mini Apps since Feb 2025 — wrong chain. Mine it for the seedless split-key recovery and embedded-on-ramp pattern only.

**Borrow from Telegram bots:** "open the app → a wallet just exists → tap to play" is the friction bar. **Avoid their footgun** (single exportable server key → Solareum's $523K drain) with a scoped, non-withdrawing, non-exportable session key — which on Seeker is already satisfied by the hardware Seed Vault for the main wallet.

---

## 6. Money-flow / vault / buy-in patterns on Solana — the cleanest PDA design AND the house-vault counterparty

**Two parts: (6a) the player-side vault lifecycle (clone Supersize's UX), and (6b) the asymmetric house-vault counterparty (the net-new Phase-1 work Supersize does NOT give you).**

### 6a. Player-side vault lifecycle (source-verified from `ephemeral-rollups-spl`)

Separate the **heavy token** from the **lightweight balance ledger:**
- **One shared vault PDA** holds the real SPL tokens — seeds `[validator, token_mint]` (or `[mint]` in the newer `ephemeral-spl-token`).
- **Per-user lightweight balance PDA** seeded by the user's own pubkey: `["token_escrow", authority, validator, token_mint, slot]` — just a `u64`.

**The lifecycle (this is exactly Supersize's production loop):**
1. **Buy-in (one batched L1 tx, one signature):** `create` + `deposit` (real tokens → shared vault, credits user's `u64`) + `delegate` the balance PDA to the ER + mint the `SessionToken`.
2. **Play (zero signatures):** N fast rounds in the ER, each auto-signed by the session key, settled against Pyth Lazer in-rollup, mutating **only the `u64` ledger** (`token_escrow_transfer` — cheap math, no real token account touched).
3. **Cash-out (one signature):** `commit_and_undelegate_accounts` flushes final balance to L1, then `withdraw` releases real tokens to the user's ATA. Redeposit redelegates for the next session.

**The single non-custodial invariant — copy it verbatim:** the `withdraw` instruction **re-derives the user's PDA from the SIGNER's pubkey and calls `ensure_is_signer(authority)`.** Because the PDA is seeded by the authority, **only the real wallet that owns the funds can ever pull them out** — the program holds no key that can redirect funds. Delegation does **not** change this: it transfers the PDA's *owner* to the Delegation Program (not to MagicBlock), and undelegation returns it to your program with final state.

https://github.com/magicblock-labs/ephemeral-rollups-spl · https://github.com/magicblock-labs/ephemeral-rollups-sdk · https://docs.magicblock.gg/pages/get-started/how-integrate-your-program/anchor

**Two base-code choices:**
- **Start from `ephemeral-rollups-spl`** (the `TokenEscrow`/vault wrapper) — battle-tested, easy to read, native (non-Anchor) program. Ships `token_escrow_create/deposit/delegate/transfer/undelegate/withdraw` with working devnet examples.
- **Evaluate `ephemeral-spl-token` (e-token)** — newer, pinocchio-based, gives `[user, mint]` Ephemeral ATAs + `[mint]` vault natively **plus a "shuttle" instruction** that bundles `init+deposit+delegate` (and can sponsor rent) into **one** tx — the smoothest possible one-click buy-in. **Vet devnet maturity before betting on it.**

### 6b. The house-vault counterparty — the real net-new work (CORRECTS "clone Supersize")

**"Clone Supersize, swap the game" is right about UX, WRONG about money topology.** Supersize is an agar.io-style PvP where the only money at stake is players' own vaults transferring to each other — **symmetric, no house, no asymmetric payout obligation.** A 2000× perp is **asymmetric**: one side can owe 2000× the other's stake. Supersize never has to make one vault solvent against a 2000× claim. The house vault is **net-new and is the real Phase-1 deliverable.** Good news: **it's buildable today on devnet.**

**The enabling primitive (the thing Phase-0 deferred — it EXISTS):** MagicBlock supports **co-delegating multiple owners' accounts into ONE ER session** and atomically committing them. Official docs: *"lock one or multiple accounts"* and *"commit and undelegation accept a LIST of accounts… committed atomically… which allows to maintain state consistency of DEPENDENT accounts."* The multiplayer example delegates **two** PDAs into the **same** ER. So a **house-treasury PDA co-delegated alongside the player PDA**, with the program moving value between them atomically, is the **documented intended pattern, not a hack.** https://docs.magicblock.gg/pages/get-started/how-integrate-your-program/quickstart · https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup · https://arxiv.org/html/2311.02650v3

**The concrete payout rail already exists as code:** `ephemeral-rollups-spl`'s `token_escrow_transfer` *"transfers an amount of escrowed token from a TokenEscrow to another TokenEscrow"* and runs **both on-chain and in the ER**. So: house escrow + player escrow both delegated; a winning round = `token_escrow_transfer(house → player)`; a loss = `transfer(player → house)`. Withdrawal stays owner-bound, so **the house can never pull the player's escrow and the player can never pull the house's.** Non-custody is enforced by the escrow program, not by trust.

**Solvency against 2000× — solved by PRE-LOCKING max payout per round, NOT by a pooled LP:**
> At round-open, the program **escrows/reserves the MAXIMUM payout the round can produce** (a function of stake × effective leverage cap × max favorable price move before forced-settle) from the house escrow, and **rejects the round (or auto-caps the stake) if the vault can't cover it.** The house then **can never owe more than is already locked in-rollup.** Because ER rounds are short-lived, this is cheap and provable.

This is on-chain, provable solvency with **zero pooled-collateral surface, no off-chain solvency assumption, no resolver.** It dovetails with the existing economics work (per-tick aggregate exposure cap + per-leverage max-stake schedule). https://www.quillaudits.com/blog/dex/perp-dex-architecture-and-security

**EXPLICITLY AVOID the pooled-LP counterparty (Jupiter JLP / Drift / Hyperliquid HLP) for v1.** It is the exact pooled-collateral / external-depositor trust+insolvency surface to avoid: **Hyperliquid's HLP was drained 3× in 2025** (POPCAT alone = $4.9M bad debt) via high-leverage thin-book attacks — at 2000× that is catastrophic. Keep the **one** good lesson — **Pyth oracle pricing makes the house un-gameable by spot manipulation** — and pair it with a single program-owned, max-payout-pre-locked house escrow. If the project ever wants third-party house capital, that's a later phase with its own risk regime. https://jup.ag/perps/jlp-earn · https://blockworks.com/news/jupiter-solana-risk-vault-hyperliquid-attack

**ER settlement safety (why the house can't withhold and the operator can't steal):** MagicBlock's settlement *"blends Optimistic and ZK rollups: fast, fraud-provable execution… with permissionless challenges"* and delegated accounts remain owner-bound, returnable **only** to the original owner program on undelegate. The detailed spec is the **Dynamic Fraud Proof paper** (read it directly: https://docs.magicblock.gg/public/Ephemeral_Rollups_Fraud_Proof.pdf · https://arxiv.org/abs/2311.02650). **The one open trust item:** public docs assert fraud-provability but did **not** surface a documented *user-initiated forced-exit* if the operator stalls — see §7 for the in-program fix.

**More rules:** Pin your ER validator in `DelegateConfig` so the user's vault **co-locates with the Lazer-feed program in the same rollup.** Use **classic SPL / USDC** — escrow code is written against `spl_token`; **avoid unproven Token-2022 extensions** (transfer hooks, confidential transfers) inside the ER until tested. **Commit at the round/session boundary, not per tick** ("anchor the end-of-match state, not every keystroke"), with periodic ER commits so a crashed session can't strand a buy-in.

---

## 7. Concrete recommendation for OUR design — tied to the two drivers

**Architecture (the spine):** `[connect existing wallet]` + `[player-owned vault PDA + co-delegated house-escrow PDA → ER]` + `[MagicBlock session key auto-signs rounds]` + `[signed Pyth Lazer decides outcomes in-rollup]` + `[max-payout pre-lock for house solvency]` + `[permissionless forceCloseRound + price-staleness bounds for liveness]` + `[single-point RPC hides the rollup]` + `[commit/undelegate → withdraw, real-wallet-only]`.

### 1. Wallet / custody direction → satisfies the **non-custodial** driver

- **Primary: connect the user's existing self-custody wallet** — Solana Wallet Standard (web), MWA/Seed Vault (Seeker), behind one `SolanaWalletPort`. The dApp never touches the key. This **reconciles with the approved on-disk removal spec** and is strictly more non-custodial than any embedded provider.
- **Remove Privy from the core path** (per the spec) — do **not** run a "keep Privy vs Turnkey bake-off" as the central decision; that reverses an approved call.
- **Embedded providers = optional, dynamically-imported fallback only**, for non-crypto web visitors with no wallet. If used, **Turnkey > Privy** (pvp.trade/Moonshot pedigree, in-enclave Solana Policy Engine). Never in the app shell, never on the GO!/round path, never holding withdraw authority. Weigh passkey/Wallet-Standard-only onboarding first.
- **Watch the Privy gotchas** if any fallback survives: WebCrypto key-sharding fails silently over plain `http://` (non-localhost must be `https`); v3 dropped `@solana/web3.js` for `@solana/kit`.

→ **Non-custodial is satisfied by the connected wallet itself.** The wallet choice is an *onboarding* decision, not a custody decision — because the **session key**, not the wallet, satisfies non-custodial for the round loop. (Watch the one custody-shaped footgun: **delegated server-signing** is a problem only if your backend can ever sign *withdrawals* — keep server signing to the fee-payer slot only.)

### 2. Signing model → kills **per-action jank**, makes **non-custodial** a code invariant

**MagicBlock `gpl_session` session keys**, scoped to *only* your game program, tight per-session expiry. **Hand-roll the safety envelope the Solana token lacks:** a method allowlist (which instructions accept session auth) + an explicit **max-cumulative-stake-per-session** cap (load-bearing at 2000×). **`withdraw` = real-wallet `Signer` only, never satisfiable by a session token.** `top_up` the session key with dust for fees, never the stake.

→ One sig at buy-in, **zero per round.** A leaked/expired session key can play but can **never** pull funds.

### 3. Money flow → **non-custodial** by construction + the asymmetric house vault

Program-owned vault PDA (heavy token in one shared `[validator, mint]` vault, lightweight `u64` per-user balance seeded by `authority`). Buy-in batches `create+deposit+delegate+create_session` into one signature; rounds mutate only the `u64`; cash-out `commit_and_undelegate` → `withdraw`. **Never** a validator bridge (HL's compromise) or pooled-collateral resolver (Flash Trade's / JLP's). **Add the net-new piece:** a **second co-delegated, program-owned house-escrow PDA** with **per-round max-payout pre-lock** (reject/cap the round if the house can't cover it). Periodic commits to bound abandonment risk.

→ **Non-custodial** via the `ensure_is_signer(authority)` withdraw idiom on both sides. **House solvency is provable** — the house can never owe more than is locked before the round starts.

### 4. Fairness + liveness → satisfies the **provable-fairness** driver and closes the keeper gap

- **Provable fairness is NOT a vault concern** — it's settled by the **signed Pyth Lazer price read in-rollup**, which you must expose as proof (the Lazer signature). Market it explicitly: *"outcomes decided by a public, externally-attested feed the operator cannot regrind"* — the structural answer to Luck.io's death.
- **Make close & liquidation PLAYER/PERMISSIONLESS-INITIATED and PURE.** A player can self-submit their close straight to the ER's open Solana RPC with the session key — submission is **not** the choke point. The same price-gated instruction liquidates a loser and closes a winner, recomputed deterministically from the in-ER Lazer-signed price + stored entry/liq price. The keeper becomes a latency convenience with **zero discretion over who/whether.** This is what makes liquidation provably non-discretionary at 2000×.
- **Own the liveness backstop in YOUR program.** The DLP's `commit_state`/`undelegate` **hard-require the operator's validator as signer with no timeout** (confirmed in `delegation-program` source). So a stalled validator freezes a player's PnL in a delegated PDA. **Bake a permissionless, time-bounded `forceCloseRound`** into the game program: after a max round duration or price-staleness window, **any** signer can settle the round at the deadline's signed price and trigger undelegation. The DLP does **not** give you this for free.
- **Bound price staleness on-chain.** The operator's pusher chooses *which* signed tick lands and *when* (it cannot forge it). Store the Lazer timestamp; reject any close/liq computed against a price older than a tight bound; on staleness, fall through to deadline settlement. This collapses price-timing manipulation into deterministic settlement.

→ Sources: `delegation-program` `commit_state.rs`/`undelegate.rs` (`require_signer(validator)`, no timeout) https://github.com/magicblock-labs/delegation-program · crank docs https://docs.magicblock.gg/pages/tools/crank/introduction · real-time oracle https://www.magicblock.xyz/blog/real-time-oracles

### 5. Latency → the #1 OPEN risk to the "instant arcade feel" thesis (MUST-MEASURE)

**Do not cite 30–50ms as our expected latency.** MagicBlock's "<50ms" is a **co-located, validator-side / "transaction-landing"** figure that requires the ephemeral machine to be **on the edge near the user**; Supersize's "~30ms" is the same, and it leans on **client-side prediction** (standard game netcode). Our **only** end-to-end datum is the Phase-0 spike: **median 1448ms** — but that hit the **hardcoded Asia validator** from a non-Asia laptop, at **`confirmed`** commitment, via a **blocking `.rpc()`**, with **no optimistic render.** At least three of those are cheaply fixable.

**Reframe the thesis honestly:** arcade "instant feel" for a 2000× tick is achievable but is a **CLIENT-RENDERING problem** (predict/render PnL from the local Pyth Lazer feed + `processed`-commitment ER reads, reconcile on commit), only **partially** dependent on raw ER round-trip. The "signing jank dissolves" and "instant feel" claims survive a few-hundred-ms tick **only if the client renders optimistically**; if it blocks on confirmation, both weaken materially.

**Phase-1 must-measure protocol (run BEFORE expressing confidence in arcade feel):**
1. Route via **Magic Router / `getClosestValidator()`** to the nearest of the four regions (Asia/EU/US/TEE) — not the hardcoded Asia URL. https://docs.magicblock.gg/pages/tools/magic-router-sdk/core-concepts
2. Submit the tx **without awaiting confirmation**.
3. Open a **websocket `accountSubscribe`** on the Round/PlayerVault PDA at **`processed`** commitment; timestamp the first account-change notification.
4. **Render PnL optimistically** from the local Lazer feed; reconcile on the ER notification.
5. Report **p50/p95** of `(submit → first processed account-change)` AND `(submit → confirmed)`, from **2–3 real consumer geographies**, not a colo box.

Caveat: nearest-of-4-regions helps users near a region; users far from all four (South America, Africa, Oceania) still pay real internet latency — true "globally <50ms" needs dynamic edge co-location we have **not** validated we get on the shared devnet/mainnet ER. https://solanacompass.com/learn/accelerate-25/scale-or-die-building-real-time-apps-on-solana-w-ephemeral-rollups · https://www.magicblock.xyz/blog/supersize

### 6. What to do in the client phase (your Phase-0 spike already proved delegate → read-Lazer-in-rollup → undelegate green)

- **Bolt session keys onto the existing spike** — drop your round-settlement instruction into the `gpl_session` `#[session_auth_or]` example; prove **zero-popup signed rounds in the ER.**
- **Stand up BOTH vault PDAs** from `ephemeral-rollups-spl` — player escrow **and** the co-delegated house escrow; prove buy-in → delegate-both → play → undelegate → withdraw end-to-end on devnet with **USDC**, with **max-payout pre-lock** rejecting an under-funded round.
- **Wire the connect-existing-wallet path** (Wallet Standard / MWA) behind one `SolanaWalletPort`, per the approved spec — *not* an embedded provider.
- **Prove the invariants in code, not docs:** (a) session key can do *everything in a round* but **can never withdraw**; (b) `withdraw` re-derives the PDA from the signer and `ensure_is_signer(authority)`; (c) `forceCloseRound` is permissionless + time-bounded; (d) close/liq reject stale prices.
- **Run the Phase-1 latency measurement** (above) and **verify on devnet** that a third-party-signed tx touching our delegated PDAs is accepted by the ER RPC, and **what happens to a delegated round when the validator is killed mid-session.**
- **Confirm with MagicBlock the forced-exit/liveness story** and read the Dynamic Fraud Proof paper directly before relying on the in-rollup house vault for real money.
- **Defer** anything off the demo's critical path (social/leaderboard layer; fiat on-ramp is the no-crypto fallback, not the first integration).

---

## Genuine disagreements & uncertainty (not papered over)

- **The original "keep Privy, run a Privy-vs-Turnkey bake-off" recommendation is REVERSED here** — it contradicts the approved on-disk spec (`docs/superpowers/specs/2026-06-25-privy-removal-wallet-adapter-design.md`: *"Do not replace Privy with another embedded wallet provider in the core app shell"*) and misses the more-non-custodial connect-existing-wallet option. The corrected primary is **connect existing wallet + session keys**, embedded providers as optional fallback only. If the founder *wants* a wallet-less-web embedded fallback, that's a real (small) decision — and there Turnkey edges Privy.
- **Client-observed ER latency is UNMEASURED for our case and is the #1 open risk to the arcade-feel driver.** Every fast number traces to MagicBlock or its grantee and is co-location-conditioned. "Signing latency stops mattering" and "instant feel" are **hypotheses until measured** under the correct config (nearest region + processed + websocket + optimistic render).
- **The house-vault solvency design is a synthesis, not a documented reference build.** The MagicBlock primitives (multi-account co-delegation, `token_escrow_transfer`, program-governed non-custody) are confirmed; **no one has publicly shipped a two-sided player-vs-house perp settled in-rollup.** Max-payout pre-lock is sound but is *our* construction to prove on devnet.
- **One un-closed non-custody/liveness item:** public docs assert fraud-provable, permissionless-challenge settlement and owner-bound undelegation, but did **not** surface a documented **user-initiated forced-exit** if the operator stalls. Our `forceCloseRound` is the in-program answer; still confirm the DLP-level liveness path with MagicBlock before real money.
- **Solana session tokens are thinner than assumed** — program-scope + expiry only; **no native spend cap or method allowlist.** At 2000× the hand-rolled spend cap is **load-bearing.**
- **Unverified precedents:** Supersize/Slimecoin's exact *login auth provider* isn't pinned from primary sources (custody/flow are; the wallet vendor isn't). Flash Trade's and Pacifica's precise per-trade signing and liquidation-keeper mechanics aren't published. Banana Zone's current custody couldn't be reconfirmed (site 403'd). Mid-session ER RPC ingress policy (open/unfiltered) is strongly implied but not explicitly documented — **verify on devnet.**
- **"Non-custodial therefore no gambling license" is LEGALLY UNTESTED.** Curaçao's LOK / Anjouan frameworks make **zero mention** of non-custodial play and assume operator custody. Non-custodial *reliably* removes the custody/AML money-handling burden and the honeypot, but does **not** guarantee escaping gambling-product licensing. Combined with the Apple/Google delisting reality (Moonshot, 250×), ship real money via **web/PWA + dApp Store**, keep a scrubbed soft-coin build for mainstream stores. **Treat licensing as a separate legal question.**

---

**Key relevant files (already on disk):**
- `spikes/lazer-probe/` (branch `onchain-er-rebuild`) — Phase-0 spike: delegate → read-Lazer-in-rollup → undelegate, GREEN on devnet; `RESULT.md` holds the 1448ms median latency datum the §7.5 measurement protocol must improve on.
- `docs/superpowers/specs/2026-06-25-privy-removal-wallet-adapter-design.md` — the **approved** Privy-removal / Wallet-Adapter design this report reconciles with (Solana Wallet Standard + MWA + Seed Vault behind one `SolanaWalletPort`; no embedded provider in the core shell; server signs only the fee-payer).

The Section 7 client-phase work bolts session keys + the player vault + the **net-new co-delegated house escrow** onto the existing Lazer-spike foundation, behind a connect-existing-wallet transport.
