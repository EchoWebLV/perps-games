# Phase 0 — Empirical Staging Runbook (stand up Privy staging + run gating test #1)

**Spec:** `2026-06-23-real-money-rails-design.md` (§5, §6, §14) · **Findings:** `2026-06-23-phase0-privy-capability-findings.md` (12-item checklist) · **Harness:** `server/src/scripts/phase0-staging.ts`

> **What this unblocks.** Phase 0's *static* half verified the Privy SDK type surface. Its *empirical* half — which needs a live Privy app + credentials only you can create — is the **gate** on Plan 2 (deposit) and Plan 3 (withdraw). **Staging test #1 (treasury fee-payer sponsorship) is the top gate:** the spec's deposit flow has the treasury (a Privy server wallet) sign a transaction as *fee-payer* while a *different* user wallet is the SPL transfer authority. The static pass could not prove Privy will actually sign a "fee-payer-only" slot (`sponsor:true` turned out to be opaque USD gas-credit billing, not on-chain fee-payer). Only a live signing call settles it.

> **🔒 Safety.** Devnet / staging only — **no real money**. Credentials go in `server/.env` (already gitignored) and are **never pasted into chat**. The harness only *signs offline*; it does **not** broadcast anything.

---

## Prerequisites

- A Privy account (dashboard.privy.io).
- This repo on branch `real-money-rails`, deps installed (`npm install` already done — `@solana/kit` + `@privy-io/node` are in place).
- Node 22 (already used by the server).

---

## Part A — Create the Privy staging app (one-time, ~5 min)

Follow Privy's current dashboard (exact navigation changes; these are the things you need to end up with):

1. **Create a new app** named e.g. `perps-raider-staging`. Keep it separate from any production app.
2. **Enable server-side wallets / the Wallet API** for the app (so the app secret can create + sign with server wallets). This is the capability the whole rails custody model rides on.
3. Capture two values:
   - **App ID** (public).
   - **App Secret** (secret — treat like a password).
4. *(Only needed for the optional Part D send test, not for test #1):* if you want to try `sponsor:true`, enable **gas sponsorship / gas credits** for the app and confirm it covers **Solana devnet**.

You do **not** need to pre-create any wallets — the harness creates a throwaway treasury + user wallet on first run and prints their ids to save.

---

## Part B — Put the credentials in `server/.env`

`server/.env` is gitignored. Add (do **not** commit, do **not** paste the secret into chat):

```
PRIVY_APP_ID=<your staging app id>
PRIVY_APP_SECRET=<your staging app secret>
```

That's all test #1 needs. (After the first harness run you'll add the four `PHASE0_*` wallet lines it prints, to reuse the same wallets on later runs.)

---

## Part C — Run gating test #1 (treasury fee-payer signing) — **no on-chain funding needed**

The core question — *will Privy sign a slot where the treasury is merely the fee-payer, not the authority?* — is an **offline signing** question, so this needs no SOL, no tokens, no RPC.

```bash
cd server
npx tsx src/scripts/phase0-staging.ts
```

On first run it creates a treasury + user wallet and prints lines to save into `server/.env`:

```
PHASE0_TREASURY_WALLET_ID=...
PHASE0_TREASURY_ADDRESS=...
PHASE0_USER_WALLET_ID=...
PHASE0_USER_ADDRESS=...
```

Then it builds a `transferChecked` tx (treasury = fee-payer, user = authority), calls `signTransaction(treasuryWalletId)`, and inspects which signature slots Privy filled.

**Interpreting the result:**

| Outcome | Meaning | Action |
|---|---|---|
| ✅ **PASS** — treasury slot signed, user slot empty | Privy signs a fee-payer-only slot. The §5 deposit-sponsorship design **holds**. | Plan 2 (deposit) may proceed on this design. Move to items 2–10. |
| ❌ **FAIL** — Privy rejects (treasury "not a required signer" / policy denies) | The §5 fee-payer-sponsorship design is **broken**. | Fall back to **user-pays-gas** / **pre-fund tiny SOL** / **Privy-chosen sponsor** — and re-plan deposit before writing Plan 2. |
| ⚠️ **INCONCLUSIVE** — unexpected signature layout | Decode the tx manually before trusting either way. | Share the output; we inspect together. |

> If you've set the credentials in `server/.env` and would rather I run it, just say so — the harness reads the secret from `.env`; I never see or print it.

---

## Part D — *(Optional)* full send + `sponsor:true` (needs devnet funding)

Test #1's signing pass is the gate. This part confirms the tx actually **lands** and inspects who pays — only do it if you want the stronger guarantee now. It needs:

1. **Devnet SOL** on the treasury (fee-payer): airdrop to `PHASE0_TREASURY_ADDRESS` (e.g. `solana airdrop 1 <addr> --url devnet`, or a web faucet).
2. **A 6-decimal SPL test mint** + the **user's ATA funded** with it + the **treasury's ATA** created (so a real `transferChecked` is valid).
3. Re-run with a real devnet blockhash and call `signAndSendTransaction(..., { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", sponsor: true })`, then inspect the landed tx: is `accountKeys[0]` (the on-chain fee-payer) the treasury, or a Privy-managed sponsor?

This is a follow-on harness mode we can add once test #1 passes; it maps to **staging items 5, 6, 11** in the findings checklist.

---

## Part E — The remaining gating items (2–10)

After test #1, the rest of the checklist (findings doc §"Remaining staging checklist") gates the *withdraw* path and the policy/quorum design. We'll extend `phase0-staging.ts` with a mode per item as we reach them:

- **2–3 idempotency / crash-replay** — send the same `idempotency_key` twice; confirm no second broadcast (needs Part D funding to broadcast).
- **4 hash semantics**, **5 byte fidelity**, **6 CAIP-2** — confirm `hash` is the on-chain signature; `sha256` of submitted vs returned message matches; the devnet CAIP-2 string is accepted.
- **7 quorum ≥2 owns wallet** — `keyQuorums().create({authorization_threshold:2,…})` then `wallets().create({owner_id})`.
- **8 pending intent persists**, **9 out-of-band authorize route** — `intents().transfer(...)` under-signed → `status:'pending'`; then determine the HTTP route a second P-256 approver POSTs `{signature,timestamp}` to (no SDK method wraps it — finding #2).
- **10 policy enforcement** — attach a policy (constraints 1–4); confirm per-instruction amount cap can't be bypassed by batching, no-mint transfers DENIED. (The rolling aggregate cap stays in our co-signer — finding #1.)

---

## Recording results

For each item, write **PASS/FAIL + the exact observation** into the staging-checklist section of `2026-06-23-phase0-privy-capability-findings.md`. **Test #1's verdict is the Plan 2 go/no-go.** No real money moves until items 1–9 pass on a live app.

## Reference

| Env var | Used by | Notes |
|---|---|---|
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | all | staging app; secret is gitignored, never in chat |
| `PHASE0_TREASURY_WALLET_ID` / `_ADDRESS` | harness | printed on first run; reuse across runs |
| `PHASE0_USER_WALLET_ID` / `_ADDRESS` | harness | the *different* authority wallet |

- **CAIP-2:** mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` · devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (confirm devnet value against the live `signAndSendTransaction` endpoint — typed as a bare string).
- **Devnet SOL faucet:** `solana airdrop` (CLI) or faucet.solana.com.
