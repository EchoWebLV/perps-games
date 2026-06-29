# Privy embedded wallet + SOL stakes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a brand-new player sign in with Privy (email/social → instant embedded wallet), fund with SOL, and play a real on-chain round zero-popup, with stakes of 0.01–0.1 SOL — without changing the deployed `raider` program (SOL rides in as wrapped SOL).

**Architecture:** Two phases. **Phase A (Tasks 1–6)** switches the stake currency to SOL via invisible **wrapped-SOL (wSOL)** — the mint-agnostic `raider` program is untouched; the client wraps SOL→wSOL before `buy_in` and unwraps on `withdraw`. Fully verifiable by the dev-keypair port in Claude Preview. **Phase B (Tasks 7–10)** adds a **`PrivyWalletPort`** behind the existing `SolanaWalletPort` seam (React island, `createElement` — no JSX/React-Vite-plugin), selected by `VITE_WALLET=privy`; the dev-keypair port stays the automated/Preview path. Phase B is gated on a **zero-popup signing spike (Task 7)** and needs a **Privy app id + a manual login→fund→play pass by the user**.

**Tech Stack:** TypeScript, `@coral-xyz/anchor` 0.31 + `@solana/web3.js` + `@solana/spl-token` (browser), Vitest, Vite, MagicBlock ER on Solana devnet. Phase B adds `react` + `react-dom` + `@privy-io/react-auth` (island only).

**Spec:** `docs/superpowers/specs/2026-06-30-privy-sol-wallet-onboarding-design.md`
**Branch:** `onchain-er-rebuild` (commit locally, do not push).
**Program:** UNCHANGED. `raider` `FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv` is mint-agnostic; this slice only swaps the house mint to wSOL and adds client wrap/unwrap.

---

## File Structure

- `redline3d/src/chain/config.ts` — rename `TEST_USDC_MINT`→`STAKE_MINT` (pointed at wSOL), `USDC_DECIMALS`→`STAKE_DECIMALS` (9). One source of truth for the stake mint + decimals.
- `redline3d/src/chain/wsol.ts` *(new)* — pure instruction builders `buildWrapIxs` / `buildUnwrapIxs` + thin `wrapSol`/`unwrapSol` runners. Sole owner of the SOL↔wSOL conversion.
- `redline3d/src/chain/chain-round.ts` — `wrapForBuyIn(lamports)` + `unwrapAll()` helpers on the `ChainRound` (build + send the wrap/unwrap via the existing `send()`); used by the session.
- `redline3d/src/chain/game-session.ts` — `ensureSession` wraps before `buy_in`; `withdraw` unwraps after.
- `redline3d/scripts/bootstrap-devnet.mjs` — bootstrap the **wSOL** house (funder wraps SOL→wSOL→`fund_house`).
- `redline3d/scripts/fund-wallet.mjs` *(new or extend)* — send native SOL to a target wallet (the Privy/dev wallet) for devnet.
- `redline3d/src/ui/controls.ts` — play-amount control becomes 0.01–0.1 SOL (centi-SOL units).
- `redline3d/src/ui/hud.ts` — `setBalance` renders SOL (asset price `setPrice` stays USD).
- `redline3d/src/main.ts` — units cents→centi-SOL, `BUY_IN_BASE` in lamports, capture live SOL/USD for the USD hint.
- `redline3d/src/chain/privy-island.tsx` *(new, Phase B)* — React island hosting `PrivyProvider` + Solana embedded-wallet signing; exposes `signTransaction(base64)`.
- `redline3d/src/chain/privy-wallet-port.ts` *(new, Phase B)* — `createPrivyPort(): SolanaWalletPort`.
- `redline3d/src/chain/wallet-select.ts` *(new, Phase B)* — pick dev-keypair vs Privy by `VITE_WALLET`.

**Units convention:** the game's legacy "cents" become **centi-SOL** (0.01 SOL). `BASE_PER_UNIT = 10 ** (STAKE_DECIMALS - 2) = 10_000_000` lamports per 0.01 SOL. `playAmount` is an integer count of 0.01-SOL units (range 1–10 = 0.01–0.1 SOL). The asset *price* (BTC/ETH/SOL) stays in USD.

**wSOL mint:** `So11111111111111111111111111111111111111112` (9 decimals).

---

## PHASE A — SOL stakes via wSOL (dev-keypair-verifiable; no Privy)

## Task 1: config — STAKE_MINT = wSOL, STAKE_DECIMALS = 9

**Files:**
- Modify: `redline3d/src/chain/config.ts`
- Modify: `redline3d/src/main.ts:93`, `redline3d/src/onchain-main.ts:56-57`
- Test: `redline3d/src/chain/config.test.ts`

- [ ] **Step 1: Update the config field names + values**

In `config.ts`, replace the `TEST_USDC_MINT` and `USDC_DECIMALS` lines:

```ts
  // Stake mint. wSOL (So111…112) so the mint-agnostic program plays in SOL with no
  // program change; the client wraps/unwraps around buy_in/withdraw. USDC later = swap this.
  STAKE_MINT: "So11111111111111111111111111111111111111112",
  STAKE_DECIMALS: 9,
```

- [ ] **Step 2: Update the three readers**

`main.ts:93`: `mint: new PublicKey(CHAIN.STAKE_MINT),`
`onchain-main.ts:56`: `if (!CHAIN.STAKE_MINT) { setText("status", "STAKE_MINT not set in config.ts — run npm run chain:bootstrap first."); return; }`
`onchain-main.ts:57`: `chain = createChainRound({ wallet: portToAnchorWallet(port), mint: new PublicKey(CHAIN.STAKE_MINT) });`

Also update any `CHAIN.USDC_DECIMALS` reference (e.g. `main.ts:83`) to `CHAIN.STAKE_DECIMALS`.

- [ ] **Step 3: Update config.test.ts**

Open `redline3d/src/chain/config.test.ts`; replace assertions referencing `TEST_USDC_MINT`/`USDC_DECIMALS` with `STAKE_MINT === "So11111111111111111111111111111111111111112"` and `STAKE_DECIMALS === 9`.

- [ ] **Step 4: Typecheck + unit suite**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors referencing `TEST_USDC_MINT`/`USDC_DECIMALS`.
Run: `cd redline3d && npm test 2>&1 | tail -6`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/config.ts redline3d/src/main.ts redline3d/src/onchain-main.ts redline3d/src/chain/config.test.ts
git commit -m "feat(chain): stake mint = wSOL, 9 decimals (SOL stakes)"
```

---

## Task 2: wsol.ts — wrap/unwrap instruction builders

**Files:**
- Create: `redline3d/src/chain/wsol.ts`
- Test: `redline3d/src/chain/wsol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WSOL_MINT, buildWrapIxs, buildUnwrapIxs } from "./wsol";

describe("wsol wrap/unwrap", () => {
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(WSOL_MINT, owner);

  it("wrap creates ATA when missing, funds it, syncs native", () => {
    const ixs = buildWrapIxs({ owner, lamports: 50_000_000n, ataExists: false });
    expect(ixs.length).toBe(3); // create ATA, transfer, syncNative
    // the transfer sends lamports to the wSOL ATA
    const transfer = ixs[1];
    expect(transfer.keys.some((k) => k.pubkey.equals(ata))).toBe(true);
  });

  it("wrap skips ATA creation when it already exists", () => {
    const ixs = buildWrapIxs({ owner, lamports: 50_000_000n, ataExists: true });
    expect(ixs.length).toBe(2); // transfer, syncNative
  });

  it("unwrap closes the wSOL ATA back to the owner", () => {
    const ixs = buildUnwrapIxs({ owner });
    expect(ixs.length).toBe(1);
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0].keys.some((k) => k.pubkey.equals(ata))).toBe(true); // closes the ATA
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/wsol.test.ts 2>&1 | tail -10`
Expected: FAIL — `wsol` module not found.

- [ ] **Step 3: Implement wsol.ts**

```ts
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/** Native SOL's SPL mint. Wrapping = transfer lamports into a wSOL token account + syncNative. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** The owner's associated wSOL token account. */
export function wsolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(WSOL_MINT, owner);
}

/**
 * Instructions to wrap `lamports` of native SOL into the owner's wSOL ATA.
 * Pass `ataExists` from a prior getAccountInfo to skip redundant ATA creation.
 */
export function buildWrapIxs(args: { owner: PublicKey; lamports: bigint; ataExists: boolean }): TransactionInstruction[] {
  const ata = wsolAta(args.owner);
  const ixs: TransactionInstruction[] = [];
  if (!args.ataExists) {
    ixs.push(createAssociatedTokenAccountInstruction(args.owner, ata, args.owner, WSOL_MINT));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey: args.owner, toPubkey: ata, lamports: args.lamports }));
  ixs.push(createSyncNativeInstruction(ata));
  return ixs;
}

/** Instruction to unwrap: close the wSOL ATA, returning all lamports (incl. rent) to the owner. */
export function buildUnwrapIxs(args: { owner: PublicKey }): TransactionInstruction[] {
  const ata = wsolAta(args.owner);
  return [createCloseAccountInstruction(ata, args.owner, args.owner, [], TOKEN_PROGRAM_ID)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/chain/wsol.test.ts 2>&1 | tail -8`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/wsol.ts redline3d/src/chain/wsol.test.ts
git commit -m "feat(chain): wSOL wrap/unwrap instruction builders"
```

---

## Task 3: chain-round — wrapForBuyIn / unwrapAll, wired into the session

**Files:**
- Modify: `redline3d/src/chain/chain-round.ts` (add 2 methods to `ChainRound`)
- Modify: `redline3d/src/chain/game-session.ts` (`ensureSession`, `withdraw`)

- [ ] **Step 1: Add to the `ChainRound` interface**

In `chain-round.ts`, in `interface ChainRound`, after `withdraw(amount: number): Promise<void>;` add:

```ts
  wrapForBuyIn(lamports: number): Promise<void>;
  unwrapAll(): Promise<void>;
```

- [ ] **Step 2: Implement the two methods**

In `createChainRound`, import the wsol helpers at the top:

```ts
import { wsolAta, buildWrapIxs, buildUnwrapIxs } from "./wsol";
```

Add these methods inside the returned object (next to `withdraw`). They reuse the existing `send()`, which builds a tx from a `{ transaction() }` builder — so wrap them in that shape:

```ts
    async wrapForBuyIn(lamports) {
      const ata = wsolAta(owner);
      const info = await baseConn.getAccountInfo(ata);
      const ixs = buildWrapIxs({ owner, lamports: BigInt(lamports), ataExists: !!info });
      await send(baseConn, {
        async transaction() { const { Transaction } = await import("@solana/web3.js"); const tx = new Transaction(); tx.add(...ixs); return tx; },
      });
    },

    async unwrapAll() {
      const ata = wsolAta(owner);
      const info = await baseConn.getAccountInfo(ata);
      if (!info) return; // nothing wrapped
      const ixs = buildUnwrapIxs({ owner });
      await send(baseConn, {
        async transaction() { const { Transaction } = await import("@solana/web3.js"); const tx = new Transaction(); tx.add(...ixs); return tx; },
      });
    },
```

(`Transaction` is already imported at the top of `chain-round.ts` — use the existing import instead of the dynamic one if present: `import { Connection, PublicKey, Transaction, ... }`. Replace the inline `import()` with the top-level `Transaction`.)

- [ ] **Step 3: Wire into game-session `ensureSession`**

In `game-session.ts`, change `ensureSession` to wrap before the buy-in:

```ts
    async ensureSession(buyInBase) {
      const c = need();
      if (isDelegated) return;
      const onL1 = await c.readPlayerBalance(false);
      if (onL1 === 0n) { await c.wrapForBuyIn(buyInBase); await c.buyIn(buyInBase); }
      await c.ensureRoundInited();
      await c.delegate();
      isDelegated = true;
    },
```

- [ ] **Step 4: Wire into game-session `withdraw`**

```ts
    async withdraw() {
      const c = need();
      const b = await c.readPlayerBalance(false);
      await c.withdraw(Number(b));
      await c.unwrapAll(); // wSOL → native SOL back in the wallet
      bal = await c.readPlayerBalance(false);
    },
```

- [ ] **Step 5: Typecheck + unit suite**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -10`
Expected: clean.
Run: `cd redline3d && npm test 2>&1 | tail -6`
Expected: PASS (game-session tests still green — the fake chain needs the 2 new methods; add `wrapForBuyIn: vi.fn(async () => {})` and `unwrapAll: vi.fn(async () => {})` to `fakeChain()` in `game-session.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/game-session.ts redline3d/src/chain/game-session.test.ts
git commit -m "feat(chain): wrap SOL on buy-in, unwrap on withdraw"
```

---

## Task 4: bootstrap a wSOL house + fund-wallet helper

**Files:**
- Modify: `redline3d/scripts/bootstrap-devnet.mjs`
- Create/confirm: `redline3d/scripts/fund-wallet.mjs`

- [ ] **Step 1: Make bootstrap handle the wSOL mint**

In `bootstrap-devnet.mjs`, the funder must hold **wSOL** before `fund_house`. After resolving `mint` (pass the wSOL mint as argv: `So11111111111111111111111111111111111111112`), and before the `mintTo`/`fundHouse` block, wrap SOL for the funder instead of minting (wSOL can't be `mintTo`'d). Replace the funder-funding lines with:

```js
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, Transaction } from "@solana/web3.js";
// ... after `const [house] = ...; const vaultToken = ...;` and init_house:
const isWsol = mint.toBase58() === "So11111111111111111111111111111111111111112";
const funderAta = getAssociatedTokenAddressSync(mint, funder.publicKey);
if (isWsol) {
  const info = await conn.getAccountInfo(funderAta);
  const ixs = [];
  if (!info) ixs.push(createAssociatedTokenAccountInstruction(funder.publicKey, funderAta, funder.publicKey, mint));
  ixs.push(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: funderAta, lamports: HOUSE_FUND }));
  ixs.push(createSyncNativeInstruction(funderAta));
  await provider.sendAndConfirm(new Transaction().add(...ixs));
} else {
  // existing createMint/getOrCreateATA/mintTo path
}
```

Set `HOUSE_FUND` to cover the 0.1-SOL × 23.75 max-payout pre-lock: `const HOUSE_FUND = Number(process.env.HOUSE_FUND || 3_000_000_000); // 3 wSOL`.

(Keep the existing feed-registry block unchanged — price feeds are independent of the stake mint.)

- [ ] **Step 2: Run the bootstrap against wSOL**

Run: `cd redline3d && ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json node scripts/bootstrap-devnet.mjs So11111111111111111111111111111111111111112 2>&1 | grep -vE "429|Retrying" | tail`
Expected: `init_house done` (first run) + `house funded: balance=3000000000 …` + registry feeds verified.

- [ ] **Step 3: Point config at the wSOL house**

`STAKE_MINT` is already `So111…112` (Task 1); the house PDA is derived from that mint, so no further config change. Confirm: the house exists by re-running Step 2 (idempotent — funds again; harmless).

- [ ] **Step 4: fund-wallet.mjs (native SOL to a target)**

Confirm `scripts/fund-wallet.mjs` exists; if it only mints SPL USDC, add/keep a native-SOL transfer mode:

```js
// node scripts/fund-wallet.mjs <PUBKEY> <SOL>  → transfers native SOL from the funder
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const target = new PublicKey(process.argv[2]); const sol = Number(process.argv[3] || 0.3);
const conn = new Connection(process.env.BASE_RPC || "https://api.devnet.solana.com", "confirmed");
const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/lazer-probe.json`, "utf8"))));
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: target, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [funder]);
console.log("funded", target.toBase58(), sol, "SOL");
```

- [ ] **Step 5: Commit**

```bash
git add redline3d/scripts/bootstrap-devnet.mjs redline3d/scripts/fund-wallet.mjs
git commit -m "feat(chain): bootstrap a wSOL house + native-SOL fund helper"
```

---

## Task 5: stake 0.01–0.1 SOL UI (controls + HUD + main units)

**Files:**
- Modify: `redline3d/src/ui/controls.ts:41,67-68`
- Modify: `redline3d/src/ui/hud.ts:76`
- Modify: `redline3d/src/main.ts:83-86,~534,~544,~553-555` + the price loop (~631)

- [ ] **Step 1: controls — play amount in 0.01-SOL units**

In `controls.ts`, the play amount is an integer count of **0.01-SOL units** (1–10). Replace line 41 and the `sup`/`sdn` handlers:

```ts
  let d: 1 | -1 = 1, playAmount = 5, live = false; // 0.01-SOL units → 0.05 SOL default
```
```ts
  q("#sup").onclick = () => { if (!live) { playAmount = Math.min(10, playAmount + 1); sval.textContent = solAmt(playAmount); } }; // +0.01 → 0.10 cap
  q("#sdn").onclick = () => { if (!live) { playAmount = Math.max(1, playAmount - 1); sval.textContent = solAmt(playAmount); } };   // -0.01 → 0.01 floor
```

Add a `solAmt` formatter near the existing `usd` helper and use it for the initial render of `sval`:

```ts
const solAmt = (units: number) => (units / 100).toFixed(2) + " SOL"; // 5 → "0.05 SOL"
```
(Find where `sval.textContent = usd(playAmount)` initializes and switch it to `solAmt(playAmount)`.)

- [ ] **Step 2: hud — balance in SOL**

In `hud.ts:76`, render the balance (now passed in 0.01-SOL units, see main.ts Step 4) as SOL:

```ts
    setBalance(b) { bal.textContent = (b / 100).toFixed(2) + " SOL"; },
```
(Leave `setPrice` as `$` — it is the asset price, not the stake.)

- [ ] **Step 3: main.ts — units constants → centi-SOL/lamports**

Replace `main.ts:83-86`:

```ts
const BASE_PER_UNIT = 10 ** (CHAIN.STAKE_DECIMALS - 2); // 9-decimal SOL, 0.01-SOL units → 10_000_000 lamports
const unitsToBase = (units: number) => units * BASE_PER_UNIT;
const baseToUnits = (base: bigint) => Number(base / BigInt(BASE_PER_UNIT));
const BUY_IN_BASE = 100_000_000; // 0.1 SOL auto buy-in float on first GO (covers one max-stake round)
```

Then replace usages: `centsToBase`→`unitsToBase`, `baseToCents`→`baseToUnits` (e.g. `main.ts:98,243,477,534,544,553`). The HUD `setBalance` now receives 0.01-SOL units from `baseToUnits(session.balance())` — unchanged call shape.

- [ ] **Step 4: main.ts — capture live SOL/USD for a USD hint**

In the feed `onPrice` wiring (`connectFeed({ feeds: ASSETS, onPrice: (k, v) => {...} })`, ~line 184), also capture SOL's price regardless of active asset, and expose it to the HUD's stake display:

```ts
    const h = connectFeed({ feeds: ASSETS, onPrice: (k, v) => { if (k === "SOL") solUsd = v; if (k === asset) onPrice(v); } });
```
Add `let solUsd = 0;` near the other price module vars (~line 415), and pass it where the play-amount/balance is rendered so the HUD can show `~$Y` next to the SOL amount (extend `hud.setBalance` to take an optional usd-per-sol, or compute the USD string in main and set a secondary label). Keep it minimal: append `(~$" + (units/100*solUsd).toFixed(2) + ")"` to the balance text when `solUsd > 0`.

- [ ] **Step 5: Typecheck + unit suite + build**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -15`
Expected: clean.
Run: `cd redline3d && npm test 2>&1 | tail -6`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add redline3d/src/ui/controls.ts redline3d/src/ui/hud.ts redline3d/src/main.ts
git commit -m "feat(game): stake 0.01–0.1 SOL with USD-equivalent display"
```

---

## Task 6: gated devnet wSOL loop test + Claude Preview SOL round

**Files:**
- Modify: `redline3d/src/chain/chain-round.devnet.test.ts` (add a wSOL loop test)

- [ ] **Step 1: Add the gated wSOL loop test**

Append inside the `describe.skipIf(!RUN)` block. It uses the **wSOL house** (the operator bootstrapped it in Task 4) and the dev-keypair port. Fund the player with native SOL, wrap → buy_in → delegate → open → close → undelegate → withdraw → unwrap, asserting conservation in lamports:

```ts
  it("plays a full SOL (wSOL) round and unwraps back to native SOL, conserved", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });

    const mint = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL house (bootstrapped)
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL })));
    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    await chain.wrapForBuyIn(100_000_000); // wrap 0.1 SOL
    await chain.buyIn(100_000_000);
    expect(await chain.readPlayerBalance()).toBe(100_000_000n);
    await chain.ensureRoundInited();
    await chain.delegate();
    await chain.open("SOL", 1, 50, 50_000_000); // 0.05 SOL stake on the SOL feed
    expect(await chain.readRoundStatus(true)).toBe(1);
    await sleep(6000);
    const settled = await chain.close();
    expect(settled.balance).toBe(100_000_000n - 50_000_000n + settled.payout); // conserved (lamports)
    await chain.commitAndUndelegate();
    const l1 = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1));
    await chain.unwrapAll();
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 180_000);
```

- [ ] **Step 2: Run the gated test**

Run: `cd redline3d && RAIDER_DEVNET=1 npx vitest run --config vitest.config.devnet.ts -t "SOL (wSOL) round" 2>&1 | grep -vE "429|Retrying" | tail -10`
Expected: 1 passed (conservation holds in lamports; the wrap/unwrap round-trips).

- [ ] **Step 3: Claude Preview — a full SOL round in the real game (operator, by me)**

Bootstrap done; point config at the wSOL house (Task 1 already set `STAKE_MINT`). Restart vite, open the game, clear the dev keypair (`localStorage.removeItem("redline.chain.devkey.v1")` + reload), read the fresh dev-keypair pubkey, fund it `node scripts/fund-wallet.mjs <pubkey> 0.4`, then drive: SOL tab → set 0.05 SOL → GO → on-chain round opens on the SOL feed with a SOL stake → crank/close settles → End → Withdraw. Verify the HUD shows SOL amounts (+ ~$ hint) and the on-chain round is correct (read the round PDA: `feed`=SOL, stake≈50_000_000).

Expected: the real game plays a SOL round end-to-end; balance moves in SOL; unwrap returns native SOL.

- [ ] **Step 4: Commit the test**

```bash
git add redline3d/src/chain/chain-round.devnet.test.ts
git commit -m "test(chain): gated devnet wSOL round, conserved in lamports"
```

> **Phase A complete:** the real game plays in SOL via wSOL, verified in Claude Preview with the dev-keypair port — no Privy yet, no program change.

---

## PHASE B — Privy embedded wallet (needs a Privy app id + a manual user pass)

> **GATE:** Before Task 8, the user must (a) create a free Privy app at dashboard.privy.io and provide its **App ID** (`VITE_PRIVY_APP_ID`), and (b) Task 7's spike must resolve zero-popup signing. Phase A is fully usable without any of this.

## Task 7: Resurrect the Privy island + zero-popup signing spike (Task 0)

**Files:**
- Create: `redline3d/src/chain/privy-island.tsx` (adapted from `git show bbb488c~1:redline3d/src/core/privy-island.ts`)
- Modify: `redline3d/package.json` (add deps)

- [ ] **Step 1: Install the Privy + React deps**

Run: `cd redline3d && npm install react@^18 react-dom@^18 @privy-io/react-auth`
(The island uses `createElement` — NO JSX — so no `@vitejs/plugin-react` is needed.)

- [ ] **Step 2: Recover the old island as a starting point**

Run: `git show bbb488c~1:redline3d/src/core/privy-island.ts > redline3d/src/chain/privy-island.tsx`
This file already mounts `PrivyProvider` via `createElement` and exposes `signTransaction(txBase64) => Promise<signedBase64>` using `useSignTransaction` from `@privy-io/react-auth/solana`. Adapt it: keep the island mount + `signTransaction`; **delete** the off-chain auth/play-balance bits (`getAccessToken`, `addWalletSigners`, `generateAuthorizationSignature`, `signAndSendTransaction` if unused). Configure the provider for **embedded wallets, no confirmation UI**:

```ts
createElement(PrivyProvider, {
  appId: import.meta.env.VITE_PRIVY_APP_ID,
  config: {
    embeddedWallets: { createOnLogin: "users-without-wallets", showWalletUIs: false },
    solanaClusters: [{ name: "devnet", rpcUrl: "https://api.devnet.solana.com" }],
  },
}, /* children: a bridge component that publishes the snapshot */)
```

- [ ] **Step 3: The spike — run a sequence of signs and observe popups**

This requires `VITE_PRIVY_APP_ID` set and a manual login (cannot be automated in Preview). Build a temporary debug button (or reuse `onchain.html`) that, after Privy login, signs **three** trivial transactions back-to-back via the island's `signTransaction`. The user runs it and reports: **does a confirmation modal appear per signature?**
  - **No modal → Option A confirmed (client-side, no server).** Proceed with Tasks 8–10 as written.
  - **Modal per tx → Option A failed.** Stop and resolve Option B (server delegated signing via `delegateWallet` + a minimal Privy Node endpoint) — out of this plan's client-only scope; surface to the user before continuing.

- [ ] **Step 4: Record the decision in the spec**

Add to the spec's Task 0 section: `RESOLVED <date>: Option A (client-side, no modal)` or `Option B (server delegated)`.

- [ ] **Step 5: Commit**

```bash
git add redline3d/package.json redline3d/package-lock.json redline3d/src/chain/privy-island.tsx docs/superpowers/specs/2026-06-30-privy-sol-wallet-onboarding-design.md
git commit -m "feat(chain): Privy Solana signing island + zero-popup spike result"
```

---

## Task 8: PrivyWalletPort behind SolanaWalletPort

**Files:**
- Create: `redline3d/src/chain/privy-wallet-port.ts`
- Test: `redline3d/src/chain/privy-wallet-port.test.ts`

- [ ] **Step 1: Write the failing test (port conforms via a mock island)**

```ts
import { describe, it, expect, vi } from "vitest";
import { createPrivyPort } from "./privy-wallet-port";

describe("privy wallet port", () => {
  it("connect resolves the embedded address; signTransaction delegates to the island", async () => {
    const island = {
      connect: vi.fn(async () => "PrivyAddr1111"),
      signTransaction: vi.fn(async (b64: string) => b64 + ".signed"),
      currentAddress: () => "PrivyAddr1111",
    };
    const port = createPrivyPort({ island });
    const res = await port.connect();
    expect(res.address).toBe("PrivyAddr1111");
    expect(await port.signTransaction("dHg=")).toBe("dHg=.signed");
    expect(port.currentAddress()).toBe("PrivyAddr1111");
    expect(port.kind).toBe("web-standard");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd redline3d && npx vitest run src/chain/privy-wallet-port.test.ts 2>&1 | tail -8`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement createPrivyPort**

```ts
import type { SolanaWalletPort } from "../core/solana-wallet";

/** The minimal island surface the port needs (the React island publishes this). */
export interface PrivyIsland {
  connect(): Promise<string>;            // triggers Privy login, ensures an embedded wallet, returns its address
  signTransaction(txBase64: string): Promise<string>;
  currentAddress(): string | null;
}

/** A SolanaWalletPort backed by a Privy embedded Solana wallet (via the React island). */
export function createPrivyPort(deps: { island: PrivyIsland }): SolanaWalletPort {
  const { island } = deps;
  let address = "";
  return {
    kind: "web-standard",
    async connect() { address = await island.connect(); return { address, label: "privy" }; },
    async disconnect() { /* island handles logout elsewhere */ },
    currentAddress() { return island.currentAddress() ?? address; },
    async signMessage() { throw new Error("privy_sign_message_unsupported"); },
    async signTransaction(txBase64: string) { return island.signTransaction(txBase64); },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd redline3d && npx vitest run src/chain/privy-wallet-port.test.ts 2>&1 | tail -8`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/privy-wallet-port.ts redline3d/src/chain/privy-wallet-port.test.ts
git commit -m "feat(chain): PrivyWalletPort behind SolanaWalletPort"
```

---

## Task 9: Wallet selection + game-session accepts the port

**Files:**
- Create: `redline3d/src/chain/wallet-select.ts`
- Modify: `redline3d/src/chain/game-session.ts` (accept an injected port)
- Modify: `redline3d/src/main.ts` (pass the selected port)

- [ ] **Step 1: wallet-select.ts**

```ts
import { createDevKeypairPort } from "./dev-keypair-port";
import type { SolanaWalletPort } from "../core/solana-wallet";

/** Pick the on-chain signer by build config. Dev-keypair is the default (Preview/tests); Privy for real users. */
export async function selectChainWalletPort(): Promise<SolanaWalletPort> {
  if (import.meta.env.VITE_WALLET === "privy") {
    const { mountPrivyIsland } = await import("./privy-island");
    const { createPrivyPort } = await import("./privy-wallet-port");
    return createPrivyPort({ island: await mountPrivyIsland() });
  }
  return createDevKeypairPort();
}
```
(Ensure `privy-island.tsx` exports `mountPrivyIsland(): Promise<PrivyIsland>` that mounts the React root and resolves once Privy is ready.)

- [ ] **Step 2: game-session accepts an injected port**

In `game-session.ts`, extend the opts and use the injected port if present:

```ts
export function createGameSession(opts: {
  mint: PublicKey;
  onSettled: (info: SettledInfo) => void;
  port?: SolanaWalletPort;            // NEW: the on-chain signer (defaults to dev-keypair)
  injectChain?: ChainRound;
  injectAddress?: string;
}): GameSession {
  const port = opts.injectChain ? null : (opts.port ?? createDevKeypairPort());
```
(Add `import type { SolanaWalletPort } from "../core/solana-wallet";`.)

- [ ] **Step 3: main.ts passes the selected port**

Where `createGameSession({ mint: ..., onSettled: ... })` is called (~line 92), make the wallet selection async and pass it:

```ts
import { selectChainWalletPort } from "./chain/wallet-select";
const session = createGameSession({ mint: new PublicKey(CHAIN.STAKE_MINT), onSettled: finalizeSettled, port: await selectChainWalletPort() });
```
(If the surrounding scope is not async, wrap the session init in the existing bootstrap async path; `selectChainWalletPort()` is dynamic-import-safe and returns the dev port synchronously-ish for the default branch.)

- [ ] **Step 4: Typecheck + unit suite + default-build Preview smoke**

Run: `cd redline3d && npx tsc --noEmit 2>&1 | tail -10` → clean.
Run: `cd redline3d && npm test 2>&1 | tail -6` → PASS.
With no `VITE_WALLET`, the dev-keypair path is unchanged — re-run the Task 6 Preview SOL round to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/chain/wallet-select.ts redline3d/src/chain/game-session.ts redline3d/src/main.ts
git commit -m "feat(game): select dev-keypair or Privy port by VITE_WALLET"
```

---

## Task 10: Manual Privy login → fund → play pass (user-run)

**Files:** none (verification).

- [ ] **Step 1: Build the Privy variant**

Run: `cd redline3d && VITE_WALLET=privy VITE_PRIVY_APP_ID=<your-app-id> npm run dev -- --port 4000 --host`

- [ ] **Step 2: The user runs the funnel**

The user (not the agent — Privy login needs a real email) opens the game and:
1. Signs in with email/social → embedded wallet created.
2. Reads the embedded wallet address (shown in the wallet panel); funds it with native SOL: `node scripts/fund-wallet.mjs <embedded-address> 0.4` (devnet).
3. SOL tab → 0.05 SOL → GO → confirms **no signing popups** during open/flip/lever/close.
4. Round settles (crank/cash out) → End → Withdraw → native SOL back in the embedded wallet.

Expected: zero-popup play on a real Privy embedded wallet, real on-chain SOL settlement.

- [ ] **Step 3: Record the result**

Update the spec's Testing section with the manual-pass outcome (date + "GREEN: Privy login→fund→play zero-popup" or the defect found).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-30-privy-sol-wallet-onboarding-design.md
git commit -m "docs: Privy manual login→fund→play pass result"
```

---

## Self-Review

**Spec coverage:** Privy embedded wallet (Tasks 7–10) ✓; SOL via wSOL (Tasks 1–4) ✓; bet 0.01–0.1 SOL + USD display (Task 5) ✓; zero-popup signing spike (Task 7) ✓; dev-keypair kept for tests/Preview (Tasks 6, 9) ✓; wSOL house bootstrap (Task 4) ✓; gated devnet wSOL test + Preview (Task 6) ✓; manual Privy pass (Task 10) ✓; custody note + React-back-in are inherent to Tasks 7–9. USDC/mainnet/lever-keeper correctly deferred (carry-forward).

**Type consistency:** `STAKE_MINT`/`STAKE_DECIMALS` used uniformly (Tasks 1,3,4,9). `wrapForBuyIn`/`unwrapAll` defined on `ChainRound` (Task 3) and called in game-session (Task 3) + the test (Task 6) + fakeChain (Task 3). `unitsToBase`/`baseToUnits`/`BASE_PER_UNIT`/`BUY_IN_BASE` consistent (Task 5). `createPrivyPort({island})` + `PrivyIsland` interface match between Tasks 8 and 9. `mountPrivyIsland()` exported by the island (Task 7/9).

**Placeholder scan:** the only deferred markers are the intentional spike-resolution (`RESOLVED <date>`) and the Option-B fallback (explicitly out of client-only scope, surfaced to the user) — both are genuine decision gates, not unfinished code.
