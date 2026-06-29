# Client Slice 1 — Minimal On-Chain Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser drive the deployed devnet `raider` program end-to-end — connect a (dev) wallet, buy in, play one BTC round settled in the MagicBlock ER, read the on-chain result, and withdraw — verified in Claude Preview.

**Architecture:** A new cohesive `redline3d/src/chain/` module wraps the `raider` IDL via `@coral-xyz/anchor` (L1 + ER providers, HTTP-poll confirmation to dodge the rpc-websockets WS bug, ownership-flip polling for delegate/undelegate). The round loop is exercised by a **dedicated minimal browser entry** (`onchain.html` + `src/onchain-main.ts`) that reuses the existing `feed` + `RoundEngine` + a slim DOM HUD. The complex, server-coupled `src/main.ts` is intentionally **left untouched** this slice (its live `×` tracks a server mark poll that does not exist in the on-chain path; rewiring it is deferred to the polish slice).

**Tech Stack:** TypeScript, Vite, Vitest (node env), `@coral-xyz/anchor@^0.31.1`, `@solana/web3.js@1.98.4`, `@solana/spl-token`, the deployed `raider` program (`FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv`).

---

## Deviation from the spec (read before starting)

The approved spec (`docs/superpowers/specs/2026-06-29-client-phase-slice1-onchain-round-design.md`) listed "Changed: `src/main.ts`". During plan research we found `main.ts`'s live multiplier/payout/buffer are driven by a **server `markRound` poll** (`serverMark`/`pollMark()`), not the local engine — there is no equivalent mid-round signal in the no-crank on-chain path, so the display must run entirely off `engine.snapshot()`. Surgically swapping that into the 762-line server-coupled loop is high-risk and violates the spec's own "minimal blast radius" principle. **This plan therefore ships a dedicated minimal entry (`onchain.html`) instead of modifying `main.ts`.** Same scope, same components otherwise; folding the on-chain path into the real game UI is the polish slice. Everything else matches the spec.

## File Structure

**New (`redline3d/src/chain/`):**
- `idl/raider.json` — copied from `onchain/raider/target/idl/raider.json` (the program ABI).
- `idl/raider.ts` — copied from `onchain/raider/target/types/raider.ts` (the `Raider` TS type for `Program<Raider>`).
- `config.ts` — devnet constants (program id, RPC/WS endpoints, BTC feed, validator, delegation program, test-USDC mint, decimals).
- `dev-keypair-port.ts` — a `SolanaWalletPort` backed by a persisted local `Keypair` (auto-signs, no popup); browser-preview + headless testable.
- `anchor-wallet.ts` — `portToAnchorWallet(port)` adapter so anchor signs through any `SolanaWalletPort`.
- `chain-round.ts` — the on-chain round client: connections/program/PDAs, HTTP-poll send helper, account reads, and the orchestration methods.

**New (entry + scripts):**
- `redline3d/onchain.html` — Vite entry for the minimal demo.
- `redline3d/src/onchain-main.ts` — the minimal browser driver (feed + RoundEngine + slim HUD + chain-round).
- `redline3d/scripts/bootstrap-devnet.mjs` — operator: create/reuse the stable test mint, `init_house`, `fund_house`; print the mint pubkey.
- `redline3d/scripts/fund-wallet.mjs` — operator: airdrop SOL + mint test USDC to a given address.

**New tests:**
- `redline3d/src/chain/config.test.ts`, `dev-keypair-port.test.ts`, `anchor-wallet.test.ts`, `chain-round.test.ts` (pure, no network).
- `redline3d/src/chain/chain-round.devnet.test.ts` — gated (`RAIDER_DEVNET=1`) full-loop integration test.

**Modified:**
- `redline3d/package.json` — add deps + scripts.
- `redline3d/tsconfig.json` — `resolveJsonModule: true`.

---

### Task 1: Dependencies, IDL vendoring, JSON import

**Files:**
- Modify: `redline3d/package.json`
- Modify: `redline3d/tsconfig.json:1-20`
- Create: `redline3d/src/chain/idl/raider.json` (copy)
- Create: `redline3d/src/chain/idl/raider.ts` (copy)
- Test: `redline3d/src/chain/idl.test.ts`

- [ ] **Step 1: Add dependencies**

Run (from `redline3d/`):
```bash
npm install @coral-xyz/anchor@^0.31.1 @solana/spl-token@^0.4.9
```
Expected: both added to `dependencies` in `package.json`, no peer-dep errors (anchor 0.31 wants `@solana/web3.js ^1.68`; the repo has 1.98.4).

- [ ] **Step 2: Vendor the IDL + types**

Run (from `redline3d/`):
```bash
mkdir -p src/chain/idl
cp ../onchain/raider/target/idl/raider.json src/chain/idl/raider.json
cp ../onchain/raider/target/types/raider.ts src/chain/idl/raider.ts
```

- [ ] **Step 3: Enable JSON imports**

In `redline3d/tsconfig.json`, add `"resolveJsonModule": true` inside `compilerOptions` (after `"esModuleInterop": true,`):
```json
    "esModuleInterop": true,
    "resolveJsonModule": true,
```

- [ ] **Step 4: Write the failing smoke test**

Create `redline3d/src/chain/idl.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import idl from "./idl/raider.json";

describe("raider IDL", () => {
  it("is the deployed program ABI with the round loop instructions", () => {
    expect(idl.address).toBe("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const names = idl.instructions.map((i) => i.name);
    for (const ix of ["buy_in", "init_round", "delegate_session", "open", "close", "force_close", "commit_and_undelegate", "withdraw"]) {
      expect(names).toContain(ix);
    }
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/chain/idl.test.ts`
Expected: PASS (1 test). If it fails to resolve the JSON import, recheck Step 3.

- [ ] **Step 6: Commit**
```bash
git add redline3d/package.json redline3d/package-lock.json redline3d/tsconfig.json redline3d/src/chain/idl
git commit -m "feat(client): vendor raider IDL + add anchor/spl-token deps"
```

---

### Task 2: chain/config.ts — devnet constants

**Files:**
- Create: `redline3d/src/chain/config.ts`
- Test: `redline3d/src/chain/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/chain/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CHAIN } from "./config";

describe("CHAIN config", () => {
  it("pins the deployed program, feed, validator and endpoints", () => {
    expect(CHAIN.PROGRAM_ID.toBase58()).toBe("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    expect(CHAIN.BTC_FEED.toBase58()).toBe("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr");
    expect(CHAIN.VALIDATOR.toBase58()).toBe("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
    expect(CHAIN.DELEGATION_PROGRAM.toBase58()).toBe("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    expect(CHAIN.ER_RPC).toBe("https://devnet.magicblock.app");
    expect(CHAIN.USDC_DECIMALS).toBe(6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/chain/config.test.ts`
Expected: FAIL (cannot find module `./config`).

- [ ] **Step 3: Write config.ts**

Create `redline3d/src/chain/config.ts`:
```ts
import { PublicKey } from "@solana/web3.js";

// Devnet on-chain constants for the deployed `raider` program. Endpoint defaults
// mirror onchain/raider/tests/helpers.ts. BASE_WS is pinned to public devnet so any
// WS-confirmation path uses a known-good socket; on-chain sends use HTTP-poll anyway.
export const CHAIN = {
  PROGRAM_ID: new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv"),
  BASE_RPC: "https://api.devnet.solana.com",
  BASE_WS: "wss://api.devnet.solana.com",
  ER_RPC: "https://devnet.magicblock.app",
  ER_WS: "wss://devnet.magicblock.app",
  BTC_FEED: new PublicKey("71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr"),
  VALIDATOR: new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
  DELEGATION_PROGRAM: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"),
  // The stable devnet test-USDC mint the demo plays against. Filled by Task 5's
  // bootstrap script output; "" means "not bootstrapped yet" (the demo will warn).
  TEST_USDC_MINT: "",
  USDC_DECIMALS: 6,
} as const;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/chain/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add redline3d/src/chain/config.ts redline3d/src/chain/config.test.ts
git commit -m "feat(client): chain/config.ts devnet constants"
```

---

### Task 3: dev-keypair SolanaWalletPort

**Files:**
- Create: `redline3d/src/chain/dev-keypair-port.ts`
- Test: `redline3d/src/chain/dev-keypair-port.test.ts`

Reference: the port interface is `redline3d/src/core/solana-wallet.ts:4-12` (`connect`/`disconnect`/`currentAddress`/`signMessage`/`signTransaction(txBase64)→base64`).

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/chain/dev-keypair-port.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";

// in-memory storage so the test does not touch real localStorage
function memStore() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) };
}

describe("dev-keypair port", () => {
  it("connects to the persisted keypair address and signs a transaction", async () => {
    const kp = Keypair.generate();
    const port = createDevKeypairPort({ secretKey: kp.secretKey, store: memStore() });
    const { address } = await port.connect();
    expect(address).toBe(kp.publicKey.toBase58());
    expect(port.currentAddress()).toBe(kp.publicKey.toBase58());

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: PublicKey.default, lamports: 1 }),
    );
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = "11111111111111111111111111111111"; // dummy 32-byte base58
    const signedB64 = await port.signTransaction(tx.serialize({ requireAllSignatures: false }).toString("base64"));
    const signed = Transaction.from(Buffer.from(signedB64, "base64"));
    expect(signed.signatures[0].signature).not.toBeNull();
  });

  it("generates and persists a keypair when none is provided", () => {
    const store = memStore();
    const a = createDevKeypairPort({ store });
    const b = createDevKeypairPort({ store });
    expect(a.currentAddress()).toBe(b.currentAddress()); // same persisted key
  });

  it("signs a message (64-byte ed25519 signature)", async () => {
    const port = createDevKeypairPort({ secretKey: Keypair.generate().secretKey, store: memStore() });
    const sig = await port.signMessage(new TextEncoder().encode("hello"));
    expect(sig.length).toBe(64);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/chain/dev-keypair-port.test.ts`
Expected: FAIL (cannot find `./dev-keypair-port`).

- [ ] **Step 3: Write dev-keypair-port.ts**

Create `redline3d/src/chain/dev-keypair-port.ts`:
```ts
import { Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { SolanaWalletPort } from "../core/solana-wallet";

const STORE_KEY = "redline.chain.devkey.v1";

interface Store {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

const browserStore: Store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/**
 * A SolanaWalletPort backed by a local Keypair — devnet/dev only. Auto-signs (no
 * popup) so the on-chain loop is testable headlessly and in Claude Preview without a
 * browser extension. The keypair is persisted (base64 secretKey) so the same address
 * survives reloads (and can be funded once by the operator). `.keypair` is exposed so
 * the anchor-wallet adapter can sign without a base64 round-trip if it wants.
 */
export function createDevKeypairPort(opts?: { secretKey?: Uint8Array; store?: Store }): SolanaWalletPort & { keypair: Keypair } {
  const store = opts?.store ?? browserStore;
  let kp: Keypair;
  if (opts?.secretKey) {
    kp = Keypair.fromSecretKey(opts.secretKey);
  } else {
    const saved = store.get(STORE_KEY);
    if (saved) {
      kp = Keypair.fromSecretKey(Buffer.from(saved, "base64"));
    } else {
      kp = Keypair.generate();
      store.set(STORE_KEY, Buffer.from(kp.secretKey).toString("base64"));
    }
  }
  const address = kp.publicKey.toBase58();
  return {
    kind: "web-standard",
    keypair: kp,
    async connect() { return { address, label: "dev-keypair" }; },
    async disconnect() { /* no-op */ },
    currentAddress() { return address; },
    async signMessage(message: Uint8Array) { return nacl.sign.detached(message, kp.secretKey); },
    async signTransaction(txBase64: string) {
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      tx.partialSign(kp);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/chain/dev-keypair-port.test.ts`
Expected: PASS (3 tests). If `tweetnacl` is missing, run `npm install tweetnacl` (it is a web3.js dep but make the import explicit).

- [ ] **Step 5: Commit**
```bash
git add redline3d/src/chain/dev-keypair-port.ts redline3d/src/chain/dev-keypair-port.test.ts redline3d/package.json redline3d/package-lock.json
git commit -m "feat(client): dev-keypair SolanaWalletPort (auto-sign, devnet)"
```

---

### Task 4: portToAnchorWallet adapter

**Files:**
- Create: `redline3d/src/chain/anchor-wallet.ts`
- Test: `redline3d/src/chain/anchor-wallet.test.ts`

- [ ] **Step 1: Write the failing test**

Create `redline3d/src/chain/anchor-wallet.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keypair, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";

function memStore() { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }; }

describe("portToAnchorWallet", () => {
  it("exposes the port address as publicKey and signs via the port", async () => {
    const kp = Keypair.generate();
    const port = createDevKeypairPort({ secretKey: kp.secretKey, store: memStore() });
    await port.connect();
    const wallet = portToAnchorWallet(port);
    expect(wallet.publicKey.toBase58()).toBe(kp.publicKey.toBase58());

    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = "11111111111111111111111111111111";
    const signed = await wallet.signTransaction(tx);
    expect(signed.signatures[0].signature).not.toBeNull();

    const all = await wallet.signAllTransactions([tx]);
    expect(all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/chain/anchor-wallet.test.ts`
Expected: FAIL (cannot find `./anchor-wallet`).

- [ ] **Step 3: Write anchor-wallet.ts**

Create `redline3d/src/chain/anchor-wallet.ts`:
```ts
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletPort } from "../core/solana-wallet";

/** The subset of anchor's Wallet that AnchorProvider requires. */
export interface AnchorWalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/**
 * Adapt any SolanaWalletPort into an anchor-compatible Wallet. The port signs base64;
 * we serialize (legacy Transaction) → port.signTransaction → deserialize. Slice 1 only
 * builds legacy transactions (anchor `.transaction()`), so the legacy branch is the
 * exercised path; versioned txs throw (not used this slice).
 */
export function portToAnchorWallet(port: SolanaWalletPort): AnchorWalletLike {
  const addr = port.currentAddress();
  if (!addr) throw new Error("wallet_port_not_connected");
  const publicKey = new PublicKey(addr);

  async function sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) throw new Error("versioned_tx_unsupported_slice1");
    const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const signedB64 = await port.signTransaction(b64);
    return Transaction.from(Buffer.from(signedB64, "base64")) as T;
  }

  return {
    publicKey,
    signTransaction: sign,
    async signAllTransactions(txs) { const out = []; for (const t of txs) out.push(await sign(t)); return out; },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/chain/anchor-wallet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add redline3d/src/chain/anchor-wallet.ts redline3d/src/chain/anchor-wallet.test.ts
git commit -m "feat(client): portToAnchorWallet adapter"
```

---

### Task 5: Operator bootstrap + fund scripts

**Files:**
- Create: `redline3d/scripts/bootstrap-devnet.mjs`
- Create: `redline3d/scripts/fund-wallet.mjs`
- Modify: `redline3d/package.json` (scripts)

These are operator tools (run once / on demand), not app code; their "test" is running them and eyeballing output. They use the funder keypair at `~/.config/solana/lazer-probe.json` (the program upgrade authority / house funder).

- [ ] **Step 1: Write bootstrap-devnet.mjs**

Create `redline3d/scripts/bootstrap-devnet.mjs`:
```js
// Operator one-time devnet bootstrap: create a stable test-USDC mint (or reuse one
// passed as argv[2]), init_house + fund_house for it, and print the mint pubkey to
// paste into src/chain/config.ts (TEST_USDC_MINT). Run:
//   ANCHOR_WALLET=~/.config/solana/lazer-probe.json node scripts/bootstrap-devnet.mjs
import anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "../src/chain/idl/raider.json" assert { type: "json" };

const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const HOUSE_FUND = Number(process.env.HOUSE_FUND || 50_000_000); // 50 USDC bankroll
const conn = new Connection(RPC, { commitment: "confirmed" });
const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
const funder = anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const mint = process.argv[2]
  ? new PublicKey(process.argv[2])
  : await createMint(conn, funder, funder.publicKey, null, 6);
console.log("MINT", mint.toBase58());

const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

const existing = await program.account.houseBalance.fetchNullable(house);
if (!existing) {
  await program.methods.initHouse().accounts({
    authority: funder.publicKey, mint, house, vaultAuthority, vaultToken,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc({ skipPreflight: true });
  console.log("init_house done");
}
const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, HOUSE_FUND);
await program.methods.fundHouse(new anchor.BN(HOUSE_FUND)).accounts({
  funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID,
}).rpc({ skipPreflight: true });
const h = await program.account.houseBalance.fetch(house);
console.log(`house funded: balance=${h.balance.toString()} locked=${h.locked.toString()}`);
console.log(`\n>>> paste into src/chain/config.ts: TEST_USDC_MINT: "${mint.toBase58()}"`);
```

- [ ] **Step 2: Write fund-wallet.mjs**

Create `redline3d/scripts/fund-wallet.mjs`:
```js
// Operator: airdrop SOL + mint test USDC to a player address. Run:
//   node scripts/fund-wallet.mjs <PLAYER_ADDRESS> <MINT_ADDRESS>
import anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readFileSync } from "node:fs";

const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const USDC = Number(process.env.USDC || 10_000_000); // 10 USDC
const conn = new Connection(RPC, { commitment: "confirmed" });
const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
const funder = anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
const player = new PublicKey(process.argv[2]);
const mint = new PublicKey(process.argv[3]);

const before = await conn.getBalance(player);
if (before < 0.05 * LAMPORTS_PER_SOL) {
  const sig = await conn.requestAirdrop(player, 0.1 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("airdropped 0.1 SOL");
}
const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player);
await mintTo(conn, funder, mint, ata.address, funder.publicKey, USDC);
console.log(`minted ${USDC} test-USDC to ${player.toBase58()} (ata ${ata.address.toBase58()})`);
```

- [ ] **Step 3: Add npm scripts**

In `redline3d/package.json` `"scripts"`, add:
```json
    "chain:bootstrap": "node scripts/bootstrap-devnet.mjs",
    "chain:fund": "node scripts/fund-wallet.mjs",
    "chain:itest": "RAIDER_DEVNET=1 vitest run src/chain/chain-round.devnet.test.ts"
```

- [ ] **Step 4: Verify the scripts parse**

Run: `node --check scripts/bootstrap-devnet.mjs && node --check scripts/fund-wallet.mjs`
Expected: no output (syntax OK). (Full execution happens in Task 10's setup.)

- [ ] **Step 5: Commit**
```bash
git add redline3d/scripts/bootstrap-devnet.mjs redline3d/scripts/fund-wallet.mjs redline3d/package.json
git commit -m "feat(client): devnet bootstrap + fund-wallet operator scripts"
```

---

### Task 6: chain-round.ts — connections, PDAs, send helper, reads (pure parts tested)

**Files:**
- Create: `redline3d/src/chain/chain-round.ts`
- Test: `redline3d/src/chain/chain-round.test.ts`

- [ ] **Step 1: Write the failing test (pure helpers: PDA derivation + raw→human)**

Create `redline3d/src/chain/chain-round.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveRaiderPdas, rawToHuman } from "./chain-round";

describe("chain-round pure helpers", () => {
  it("derives the same PDAs the program expects", () => {
    const owner = new PublicKey("FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM");
    const mint = new PublicKey("3TDF3grFqPJEdX4BhoCYzZuiRG6wrhKYE89wxoEg5kMX");
    const program = new PublicKey("FwUNcUaRbYGiWasHa6DA3xQaQJfZWCgH7UhDeBvoJcBv");
    const pdas = deriveRaiderPdas(program, owner, mint);
    const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], program);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program);
    const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], program);
    expect(pdas.player.equals(player)).toBe(true);
    expect(pdas.house.equals(house)).toBe(true);
    expect(pdas.round.equals(round)).toBe(true);
  });

  it("converts on-chain raw price + expo to a human float matching the feed scale", () => {
    // entry_raw 5998901507911 with |expo| 8 => ~59989.02 (same scale as feed price)
    expect(rawToHuman(5998901507911, 8)).toBeCloseTo(59989.02, 1);
    expect(rawToHuman(5998901507911, -8)).toBeCloseTo(59989.02, 1); // sign-agnostic
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/chain/chain-round.test.ts`
Expected: FAIL (cannot find `./chain-round`).

- [ ] **Step 3: Write chain-round.ts (constructor + pure helpers + send + reads)**

Create `redline3d/src/chain/chain-round.ts`:
```ts
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CHAIN } from "./config";
import idlJson from "./idl/raider.json";
import type { Raider } from "./idl/raider";
import type { AnchorWalletLike } from "./anchor-wallet";

const { BN } = anchor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RaiderPdas { player: PublicKey; house: PublicKey; round: PublicKey; vaultAuthority: PublicKey; vaultToken: PublicKey; }

/** Derive the four raider PDAs + the vault ATA for an owner+mint (matches lib.rs seeds). */
export function deriveRaiderPdas(programId: PublicKey, owner: PublicKey, mint: PublicKey): RaiderPdas {
  const [player] = PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer(), mint.toBuffer()], programId);
  const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], programId);
  const [round] = PublicKey.findProgramAddressSync([Buffer.from("round"), owner.toBuffer()], programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId);
  const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
  return { player, house, round, vaultAuthority, vaultToken };
}

/** On-chain Lazer raw mantissa + |expo| → human float (same scale as the client feed). */
export function rawToHuman(raw: number | bigint, expo: number): number {
  return Number(raw) * Math.pow(10, -Math.abs(expo));
}

export interface OpenedRound { entryRaw: bigint; entryExpo: number; entryHuman: number; deadlineTs: number; }
export interface SettledRound { outcome: number; outcomeName: string; payout: bigint; exitRaw: bigint; exitHuman: number; balance: bigint; }
const OUTCOME = ["cashout", "cap", "liq", "time"];

export interface ChainRound {
  address: string;
  readPlayerBalance(onEr?: boolean): Promise<bigint>;
  readRoundStatus(onEr?: boolean): Promise<number>;
  buyIn(amount: number): Promise<void>;
  ensureRoundInited(): Promise<void>;
  delegate(): Promise<void>;
  open(dir: 1 | -1, lev: number, stake: number): Promise<OpenedRound>;
  close(): Promise<SettledRound>;
  forceClose(): Promise<SettledRound>;
  commitAndUndelegate(): Promise<void>;
  withdraw(amount: number): Promise<void>;
}

export function createChainRound(deps: { wallet: AnchorWalletLike; mint: PublicKey }): ChainRound {
  const { wallet, mint } = deps;
  const owner = wallet.publicKey;
  const baseConn = new Connection(CHAIN.BASE_RPC, { commitment: "confirmed" });
  const erConn = new Connection(CHAIN.ER_RPC, { commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet as anchor.Wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(CHAIN.ER_RPC, { wsEndpoint: CHAIN.ER_WS, commitment: "confirmed" }), wallet as anchor.Wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idlJson as Raider, baseProvider);
  const programER = new anchor.Program(idlJson as Raider, erProvider);
  const pdas = deriveRaiderPdas(CHAIN.PROGRAM_ID, owner, mint);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);

  // HTTP send + getSignatureStatuses poll — dodges the rpc-websockets v9
  // "Unknown action 'undefined'" bug on the ER/Helius signature stream (helpers.ts:37).
  async function send(conn: Connection, builder: { transaction(): Promise<Transaction> }, cuLimit?: number): Promise<string> {
    const tx = await builder.transaction();
    if (cuLimit) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    tx.feePayer = owner;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        return sig;
      }
      await sleep(1000);
    }
    throw new Error(`tx ${sig} not confirmed within 60s`);
  }

  async function pollOwner(target: PublicKey, label: string, tries: number, gapMs: number) {
    for (let i = 0; i < tries; i++) {
      const infos = await Promise.all([pdas.player, pdas.house, pdas.round].map((p) => baseConn.getAccountInfo(p)));
      if (infos.every((info) => info && info.owner.equals(target))) return;
      await sleep(gapMs);
    }
    throw new Error(`${label}: PDAs did not reach owner ${target.toBase58()} in time`);
  }

  return {
    address: owner.toBase58(),

    async readPlayerBalance(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.playerBalance.fetchNullable(pdas.player);
      return acct ? BigInt(acct.balance.toString()) : 0n;
    },
    async readRoundStatus(onEr = false) {
      const prog = onEr ? programER : program;
      const acct = await prog.account.round.fetchNullable(pdas.round);
      return acct ? Number(acct.status) : 0;
    },

    async buyIn(amount) {
      await send(baseConn, program.methods.buyIn(new BN(amount)).accounts({
        owner, mint, player: pdas.player, ownerToken: ownerAta, vaultAuthority: pdas.vaultAuthority, vaultToken: pdas.vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }));
    },

    async ensureRoundInited() {
      const existing = await program.account.round.fetchNullable(pdas.round);
      if (existing) return;
      await send(baseConn, program.methods.initRound().accounts({ owner, round: pdas.round, systemProgram: SystemProgram.programId }));
    },

    async delegate() {
      await send(baseConn, program.methods.delegateSession().accounts({
        payer: owner, mint, player: pdas.player, house: pdas.house, round: pdas.round,
      }).remainingAccounts([{ pubkey: CHAIN.VALIDATOR, isSigner: false, isWritable: false }]), 400_000);
      await pollOwner(CHAIN.DELEGATION_PROGRAM, "delegate", 25, 1000);
    },

    async open(dir, lev, stake) {
      await send(erConn, programER.methods.open(dir, lev, new BN(stake)).accounts({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      return { entryRaw: BigInt(r.entryRaw.toString()), entryExpo: Number(r.entryExpo), entryHuman: rawToHuman(BigInt(r.entryRaw.toString()), Number(r.entryExpo)), deadlineTs: Number(r.deadlineTs) };
    },

    async close() {
      await send(erConn, programER.methods.close().accounts({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, playerAuthority: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()) };
    },

    async forceClose() {
      await send(erConn, programER.methods.forceClose().accounts({
        player: pdas.player, house: pdas.house, round: pdas.round, mint, priceUpdate: CHAIN.BTC_FEED, caller: owner,
      }));
      const r = await programER.account.round.fetch(pdas.round);
      const p = await programER.account.playerBalance.fetch(pdas.player);
      return { outcome: Number(r.outcome), outcomeName: OUTCOME[Number(r.outcome)] ?? "?", payout: BigInt(r.payout.toString()), exitRaw: BigInt(r.exitRaw.toString()), exitHuman: rawToHuman(BigInt(r.exitRaw.toString()), Number(r.entryExpo)), balance: BigInt(p.balance.toString()) };
    },

    async commitAndUndelegate() {
      await send(erConn, programER.methods.commitAndUndelegate().accounts({
        payer: owner, player: pdas.player, house: pdas.house, round: pdas.round, mint,
      }));
      await pollOwner(CHAIN.PROGRAM_ID, "undelegate", 40, 2000);
    },

    async withdraw(amount) {
      await send(baseConn, program.methods.withdraw(new BN(amount)).accounts({
        owner, mint, player: pdas.player, vaultAuthority: pdas.vaultAuthority, vaultToken: pdas.vaultToken, ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID,
      }));
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/chain/chain-round.test.ts`
Expected: PASS (2 tests). Network methods are unexercised here — they are covered by Task 8.

- [ ] **Step 5: Typecheck the module**

Run: `npx tsc --noEmit`
Expected: no errors. (If `idlJson as Raider` complains, the cast is required because the JSON import is untyped — keep the `as Raider`.)

- [ ] **Step 6: Commit**
```bash
git add redline3d/src/chain/chain-round.ts redline3d/src/chain/chain-round.test.ts
git commit -m "feat(client): chain-round.ts — PDAs, HTTP-confirm send, round methods"
```

---

### Task 7: Gated devnet integration test (the chain-round proof)

**Files:**
- Create: `redline3d/src/chain/chain-round.devnet.test.ts`

This is the real proof that `chain-round.ts` drives the deployed program. It is **gated** by `RAIDER_DEVNET=1` so the normal `npm test` (CI) never hits the network. It does operator setup (fresh mint + house, fund, mint to the player) with the funder keypair, then exercises chain-round via the dev-keypair port.

- [ ] **Step 1: Write the integration test**

Create `redline3d/src/chain/chain-round.devnet.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, mintTo, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import idl from "./idl/raider.json";
import { createDevKeypairPort } from "./dev-keypair-port";
import { portToAnchorWallet } from "./anchor-wallet";
import { createChainRound } from "./chain-round";

const RUN = process.env.RAIDER_DEVNET === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)("chain-round devnet loop", () => {
  it("buy_in -> delegate -> open -> close -> undelegate -> withdraw, conserved + recomputable", async () => {
    const RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const wpath = process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/lazer-probe.json`;
    const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(wpath, "utf8"))));
    const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(funder), { commitment: "confirmed" });
    const program = new anchor.Program(idl as anchor.Idl, provider);

    // --- operator setup: fresh mint + house, funded ---
    const mint = await createMint(conn, funder, funder.publicKey, null, 6);
    const [house] = PublicKey.findProgramAddressSync([Buffer.from("house"), mint.toBuffer()], program.programId);
    const [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program.programId);
    const vaultToken = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    await program.methods.initHouse().accounts({ authority: funder.publicKey, mint, house, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
    const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey);
    await mintTo(conn, funder, mint, funderAta.address, funder.publicKey, 50_000_000);
    await program.methods.fundHouse(new anchor.BN(50_000_000)).accounts({ funder: funder.publicKey, mint, house, funderToken: funderAta.address, vaultAuthority, vaultToken, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });

    // --- player: dev-keypair wallet, funded with SOL + test USDC ---
    const player = Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })));
    const playerAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
    await mintTo(conn, funder, mint, playerAta.address, funder.publicKey, 5_000_000);

    const port = createDevKeypairPort({ secretKey: player.secretKey, store: { get: () => null, set: () => {} } });
    await port.connect();
    const chain = createChainRound({ wallet: portToAnchorWallet(port), mint });

    // --- the loop ---
    await chain.buyIn(5_000_000);
    expect(await chain.readPlayerBalance()).toBe(5_000_000n);
    await chain.ensureRoundInited();
    await chain.delegate();

    const opened = await chain.open(1, 100, 1_000_000); // long, 100x, 1 USDC
    expect(opened.entryHuman).toBeGreaterThan(1000); // BTC in the tens of thousands
    expect(await chain.readRoundStatus(true)).toBe(1); // open on ER

    await sleep(6000); // let the feed move so exit != entry
    const settled = await chain.close();
    expect(["cashout", "cap", "liq", "time"]).toContain(settled.outcomeName);
    // conservation: player balance == (5 - stake) + payout
    expect(settled.balance).toBe(5_000_000n - 1_000_000n + settled.payout);

    await chain.commitAndUndelegate();
    expect(await chain.readRoundStatus(false)).toBe(2); // settled, durable on L1

    const l1Balance = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(l1Balance));
    expect(await chain.readPlayerBalance(false)).toBe(0n);
  }, 180_000);
});
```

- [ ] **Step 2: Confirm it SKIPS without the flag**

Run: `npx vitest run src/chain/chain-round.devnet.test.ts`
Expected: 1 skipped, 0 failed (no network touched).

- [ ] **Step 3: Run it against devnet**

Run: `RAIDER_DEVNET=1 ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json npx vitest run src/chain/chain-round.devnet.test.ts`
Expected: PASS (1 test, ~60–120s). It proves the full loop. If `delegate` times out, the ER may be slow — re-run; if `close` errors `StalePrice`, the feed lagged — re-run.

- [ ] **Step 4: Commit**
```bash
git add redline3d/src/chain/chain-round.devnet.test.ts
git commit -m "test(client): gated devnet integration test for chain-round full loop"
```

---

### Task 8: Minimal browser entry — onchain.html + onchain-main.ts

**Files:**
- Create: `redline3d/onchain.html`
- Create: `redline3d/src/onchain-main.ts`

Reuses the existing feed wiring (`main.ts:192-204`), `createPriceSource` (`price-source.ts`), and `RoundEngine` (`round.ts`). Display runs entirely off `engine.snapshot()` (no server mark). Leverage is locked at GO (no mid-round `lever` on-chain in Slice 1). Entry seeds the engine with `opened.entryHuman` (NOT the raw mantissa — see `rawToHuman`).

- [ ] **Step 1: Write onchain.html**

Create `redline3d/onchain.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Perps Raider — on-chain (devnet)</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0a0a12; color: #e6e6f0; margin: 0; padding: 16px; }
      .row { margin: 8px 0; } button { font: inherit; padding: 8px 14px; margin-right: 8px; cursor: pointer; }
      #mult { font-size: 42px; font-weight: 700; } .dim { color: #8a8aa0; } code { color: #9ad; }
      input { font: inherit; background: #16161f; color: #e6e6f0; border: 1px solid #333; padding: 4px; }
    </style>
  </head>
  <body>
    <h2>Perps Raider — on-chain round (devnet) <span class="dim">BTC</span></h2>
    <div class="row dim">wallet: <code id="addr">…</code> · play balance: <code id="bal">…</code> USDC</div>
    <div class="row">
      dir <select id="dir"><option value="1">LONG</option><option value="-1">SHORT</option></select>
      lev <input id="lev" type="number" min="10" max="2000" value="100" style="width:90px" />
      stake <input id="stake" type="number" min="0.01" step="0.01" value="1" style="width:90px" /> USDC
    </div>
    <div class="row">
      <button id="session">Start session</button>
      <button id="go" disabled>GO</button>
      <button id="end" disabled>End session</button>
      <button id="withdraw" disabled>Withdraw all</button>
    </div>
    <div class="row" id="mult">×1.00</div>
    <div class="row dim" id="status">connect: fund the wallet above, then Start session.</div>
    <script type="module" src="/src/onchain-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write onchain-main.ts**

Create `redline3d/src/onchain-main.ts`:
```ts
import { PublicKey } from "@solana/web3.js";
import { CHAIN } from "./chain/config";
import { createDevKeypairPort } from "./chain/dev-keypair-port";
import { portToAnchorWallet } from "./chain/anchor-wallet";
import { createChainRound, type SettledRound } from "./chain/chain-round";
import { createPriceSource } from "./core/price-source";
import { connectFeed } from "./core/feed";
import { RoundEngine } from "./core/round";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const setText = (id: string, t: string) => { $(id).textContent = t; };
const usd = (lamports: bigint) => (Number(lamports) / 10 ** CHAIN.USDC_DECIMALS).toFixed(2);

const port = createDevKeypairPort();
let chain: ReturnType<typeof createChainRound> | null = null;
const engine = new RoundEngine();
const MAXSEC = 60;
let roundStartMs = 0;
let delegated = false;
let busy = false;

// BTC feed only (the on-chain program is BTC). priceSource.price() is a human float.
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: [{ key: "BTC", lz: 1, hx: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8 }], onPrice: (k, v) => { if (k === "BTC") onPrice(v); } });
    return () => h.stop();
  },
});
addEventListener("pagehide", () => priceSource.stop());

async function refreshBalance(onEr = false) {
  if (!chain) return;
  try { setText("bal", usd(await chain.readPlayerBalance(onEr))); } catch { /* keep last */ }
}

async function init() {
  await port.connect();
  setText("addr", port.currentAddress() ?? "?");
  if (!CHAIN.TEST_USDC_MINT) { setText("status", "TEST_USDC_MINT not set in config.ts — run npm run chain:bootstrap first."); return; }
  chain = createChainRound({ wallet: portToAnchorWallet(port), mint: new PublicKey(CHAIN.TEST_USDC_MINT) });
  await refreshBalance(false);
  setText("status", "Fund the wallet (npm run chain:fund <addr> <mint>), then Start session.");
}

$("session").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    setText("status", "buying in…");
    const bal = await chain.readPlayerBalance(false);
    if (bal === 0n) await chain.buyIn(2_000_000); // 2 USDC buy-in from wallet test-USDC
    await chain.ensureRoundInited();
    setText("status", "delegating session to the ER (~8s)…");
    await chain.delegate();
    delegated = true;
    await refreshBalance(true);
    (($("go") as HTMLButtonElement).disabled = false);
    (($("end") as HTMLButtonElement).disabled = false);
    setText("status", "session live. Set dir/lev/stake and press GO.");
  } catch (e) { setText("status", `session failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

$("go").onclick = async () => {
  if (!chain || busy || engine.getPhase() === "live" || !delegated) return;
  busy = true;
  try {
    const dir = Number(($("dir") as HTMLSelectElement).value) as 1 | -1;
    const lev = Math.max(10, Math.min(2000, Math.round(Number(($("lev") as HTMLInputElement).value))));
    const stake = Math.round(Number(($("stake") as HTMLInputElement).value) * 10 ** CHAIN.USDC_DECIMALS);
    setText("status", "opening on-chain…");
    const opened = await chain.open(dir, lev, stake);
    roundStartMs = Date.now();
    engine.launch({ dir, lev, stake, entryRaw: opened.entryHuman, startMs: roundStartMs });
    setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. CASH OUT before liq.`);
  } catch (e) { setText("status", `open failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

async function settle(kind: "cashout" | "expire") {
  if (!chain || busy || engine.getPhase() !== "live") return;
  busy = true;
  engine.cashout(priceSource.price(), Date.now()); // freeze the local visual
  setText("status", kind === "cashout" ? "closing on-chain…" : "time cap — closing…");
  try {
    const res: SettledRound = await chain.close();
    setText("mult", `×${(Number(res.payout) / Math.max(1, Number(res.payout > 0n ? res.payout : 1n)) , res).toString?.() ?? ""}`);
    setText("status", `${res.outcomeName.toUpperCase()} — payout ${usd(res.payout)} USDC. balance ${usd(res.balance)}.`);
    setText("mult", res.outcome === 2 ? "💥 liquidated" : `settled · +${usd(res.payout)}`);
    await refreshBalance(true);
  } catch (e) { setText("status", `close failed: ${(e as Error).message}`); }
  finally { busy = false; }
}

$("go").addEventListener("dblclick", () => {}); // no-op guard placeholder removed below

$("end").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    setText("status", "committing + undelegating…");
    await chain.commitAndUndelegate();
    delegated = false;
    (($("go") as HTMLButtonElement).disabled = true);
    (($("withdraw") as HTMLButtonElement).disabled = false);
    await refreshBalance(false);
    setText("status", "session ended. You can Withdraw all.");
  } catch (e) { setText("status", `end failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

$("withdraw").onclick = async () => {
  if (!chain || busy) return;
  busy = true;
  try {
    const bal = await chain.readPlayerBalance(false);
    await chain.withdraw(Number(bal));
    await refreshBalance(false);
    setText("status", `withdrew ${usd(bal)} USDC to the wallet ATA.`);
  } catch (e) { setText("status", `withdraw failed: ${(e as Error).message}`); }
  finally { busy = false; }
};

// CASH OUT = press GO again while live (the button doubles as cash-out)
$("go").addEventListener("click", () => { if (engine.getPhase() === "live") void settle("cashout"); });

// display loop: equity/payout from the local engine snapshot (no server mark in slice 1)
function frame() {
  if (engine.getPhase() === "live") {
    const price = priceSource.price();
    const now = Date.now();
    const snap = engine.snapshot(price, now);
    setText("mult", `×${Math.max(0, snap.equity).toFixed(2)}`);
    if ((now - roundStartMs) / 1000 >= MAXSEC) void settle("expire");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

void init();
```

> Implementer note: the `$("go").onclick` open-handler and the separate `$("go").addEventListener("click", …)` cash-out listener must not both fire an action in the same press. Implement the GO button as: if `engine.getPhase() !== "live"` → open; else → cashout. Collapse the two handlers into one `onclick` that branches on phase (remove the stray `dblclick`/placeholder lines and the malformed `setText("mult", …)` line above — keep only the two clean `setText("mult", …)` / `setText("status", …)` lines in `settle`). The duplicated/garbled lines in the draft are a transcription artifact; the branch-on-phase handler is the intended behavior.

- [ ] **Step 3: Clean up the GO handler (single branch-on-phase handler)**

Replace the two GO handlers + the garbled `setText("mult", …)` line with this single correct block (delete the `$("go").addEventListener("dblclick", …)` and the trailing `$("go").addEventListener("click", …)` lines, and fix `settle`'s body):

```ts
// in settle(): replace the garbled mult line — set status + a clean result label only
    const res: SettledRound = await chain.close();
    setText("status", `${res.outcomeName.toUpperCase()} — payout ${usd(res.payout)} USDC. balance ${usd(res.balance)}.`);
    setText("mult", res.outcome === 2 ? "💥 liquidated" : `settled · +${usd(res.payout)} USDC`);
    await refreshBalance(true);
```
```ts
// the ONE GO handler (replaces both prior $("go") click handlers):
$("go").onclick = async () => {
  if (!chain || busy || !delegated) return;
  if (engine.getPhase() === "live") { void settle("cashout"); return; }
  busy = true;
  try {
    const dir = Number(($("dir") as HTMLSelectElement).value) as 1 | -1;
    const lev = Math.max(10, Math.min(2000, Math.round(Number(($("lev") as HTMLInputElement).value))));
    const stake = Math.round(Number(($("stake") as HTMLInputElement).value) * 10 ** CHAIN.USDC_DECIMALS);
    setText("status", "opening on-chain…");
    const opened = await chain.open(dir, lev, stake);
    roundStartMs = Date.now();
    engine.launch({ dir, lev, stake, entryRaw: opened.entryHuman, startMs: roundStartMs });
    setText("status", `LIVE — entry $${opened.entryHuman.toFixed(2)}. Press GO again to CASH OUT.`);
  } catch (e) { setText("status", `open failed: ${(e as Error).message}`); }
  finally { busy = false; }
};
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (no unused locals — `noUnusedLocals` is on). Remove any leftover unused imports.

- [ ] **Step 5: Build smoke**

Run: `npm run build`
Expected: `tsc --noEmit` passes and `vite build` succeeds (the demo imports anchor/web3 — confirm the Buffer polyfill resolves; `vite.config.ts` already enables `nodePolyfills({ globals: { Buffer, global, process } })`).

- [ ] **Step 6: Commit**
```bash
git add redline3d/onchain.html redline3d/src/onchain-main.ts
git commit -m "feat(client): minimal on-chain browser entry (onchain.html + onchain-main.ts)"
```

---

### Task 9: Devnet bootstrap + Claude Preview verification

**Files:** none (operational verification). Records the browser proof per the "verify UI in browser before done" rule.

- [ ] **Step 1: Bootstrap the stable mint + house (operator, once)**

Run (from `redline3d/`):
```bash
ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json npm run chain:bootstrap
```
Expected: prints `MINT <pubkey>`, `init_house done` (first run), `house funded: balance=50000000 locked=0`, and the paste line. Copy the mint pubkey.

- [ ] **Step 2: Set TEST_USDC_MINT in config.ts**

Edit `redline3d/src/chain/config.ts`: set `TEST_USDC_MINT: "<the pubkey from Step 1>",`. Commit:
```bash
git add redline3d/src/chain/config.ts && git commit -m "chore(client): set devnet TEST_USDC_MINT"
```

- [ ] **Step 3: Start the dev server + open the demo in Preview**

Use the preview tools (NOT Bash) to run the dev server and load the page:
- `preview_start` the dev server (`npm run dev`, port 3000), then navigate to `/onchain.html`.
- `preview_snapshot` to read the wallet address shown in `#addr`.

- [ ] **Step 4: Fund the preview wallet**

Run (operator, with the address from Step 3 and the mint from Step 1):
```bash
ANCHOR_WALLET=$HOME/.config/solana/lazer-probe.json npm run chain:fund -- <ADDR> <MINT>
```
Expected: `airdropped 0.1 SOL` (if needed) + `minted 10000000 test-USDC to <ADDR>`.

- [ ] **Step 5: Drive a round in Preview**

- `preview_click` **Start session**; poll `preview_snapshot` until `#status` shows "session live" (delegation ~8s). Confirm `#bal` reflects the on-chain play balance.
- Set lev/stake (`preview_fill`), `preview_click` **GO**; confirm `#mult` ticks (`×…`) off the live feed via `preview_snapshot` over a few seconds.
- `preview_click` **GO** again to CASH OUT; confirm `#status` shows an outcome (cashout/cap/liq/time) + a payout, and `#bal` updates.
- `preview_click` **End session**, then **Withdraw all**; confirm `#status` shows the withdraw.
- `preview_console_logs` + `preview_network` to confirm no uncaught errors and that calls hit `devnet.magicblock.app` (ER) + `api.devnet.solana.com` (L1).

- [ ] **Step 6: Capture proof**

`preview_screenshot` after a settled round (showing the outcome + balance). This is the Slice-1 "it works in the browser against devnet" artifact.

- [ ] **Step 7: Cross-check on-chain truth**

Run:
```bash
solana account <player PDA> -u devnet  # or re-read via a quick node one-liner
```
Confirm the on-chain `Round.payout` / `PlayerBalance.balance` match what the HUD displayed. (Optional but closes the "HUD == chain" loop.)

---

## Self-Review

**1. Spec coverage:**
- Connect wallet → dev-keypair port (Task 3) ✅. Note: the spec's web `SolanaWalletPort` reuse for *real* wallets is intentionally deferred (a Phantom popup can't be driven in Claude Preview, so the dev-keypair port is the browser-verifiable path this slice; the web adapter is a later/manual add). The dev port still implements the `SolanaWalletPort` interface, so the web wallet is a drop-in later.
- buy_in / init_round / delegate / open / close / force_close / commit_and_undelegate / withdraw → chain-round.ts (Task 6) ✅. `force_close` is exposed for the backstop even though the demo uses `close` for the time-cap (close past deadline relabels to `time`) ✅.
- Settlement = player-close + time backstop, no crank ✅ (frame loop auto-`close` at MAXSEC; no keeper/tick).
- HUD reads on-chain PlayerBalance/Round ✅ (Task 8 `refreshBalance`, `close` returns on-chain payout/balance).
- Display = local RoundEngine sim seeded from on-chain entry (converted to human units) ✅; truth = on-chain `close` ✅.
- Server left dormant ✅ (separate entry; `main.ts` untouched).
- HTTP-confirm + CU-bump gotchas baked in ✅ (Task 6 `send`). Delegation handled via ownership-poll (more robust than a fixed sleep) ✅.
- Testing: headless devnet integration test (Task 7) + Claude Preview verification (Task 9) ✅.
- Carry-forwards (price>0 guard on flip/lever, feedauth extension, crank-before-real-money) are not in scope and not touched ✅.

**2. Placeholder scan:** The Task 8 draft contained a deliberately-flagged garbled line + duplicate GO handlers; Task 8 Step 3 replaces them with the clean, final code. No `TBD`/`TODO` remain.

**3. Type consistency:** `createChainRound` returns the `ChainRound` interface used by `onchain-main.ts`; `open()` returns `OpenedRound` (`entryHuman` consumed by `engine.launch`); `close()`/`forceClose()` return `SettledRound` (`outcome`/`payout`/`balance` consumed by the HUD). `portToAnchorWallet` returns `AnchorWalletLike`, accepted by `createChainRound({ wallet })`. `RoundEngine.launch({ dir, lev, stake, entryRaw, startMs })` and `engine.snapshot(price, nowMs)` / `engine.cashout(price, nowMs)` match `round.ts:25-62`. `priceSource.price()` returns a number (`price-source.ts:36`). Field names (`entryRaw`, `entryExpo`, `deadlineTs`, `exitRaw`, `payout`, `balance`, `status`, `outcome`) match the IDL camelCase confirmed from `raider.ts`.

**Known risk re-stated (devnet only):** with no keeper/crank, intra-round liquidation is not enforced — fine for the devnet test-USDC proof; a keeper/crank must run before any real-money cutover (Slice 3 / mainnet). Not a code task here.
