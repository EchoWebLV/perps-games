# Money Rails 3 — Withdraw Send-Leg (self-custody treasury signer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move in-game `cash` winnings out to a user's Solana wallet via a treasury keypair the server holds (no Privy), built and proven on devnet first.

**Architecture:** Three new units plus composition-root wiring. `chain-status.ts` reads on-chain finality, `treasury-signer.ts` implements the existing `WithdrawSigner` port using the local-keypair pattern, and `withdraw-confirm-loop.ts` polls `sent` rows through the existing confirmer. `index.ts` wires them only when `TREASURY_SECRET` is set — otherwise behavior is identical to today (`payoutSigner` stays `null`; round wins never auto-push on-chain).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@solana/kit` v5, `@solana-program/token`, Drizzle (Postgres), Vitest, Fastify. Spec: [docs/superpowers/specs/2026-06-25-money-rails-3-withdraw-signer-design.md](../specs/2026-06-25-money-rails-3-withdraw-signer-design.md).

**Conventions to follow:**
- Run a single test file from `server/`: `npx vitest run src/path/to/file.test.ts`
- All intra-package imports use the `.js` extension (e.g. `import { x } from "./foo.js"`).
- Money is integer cents in the ledger; on-chain amounts are USDC base units via `centsToBaseUnits` (6 decimals).
- Commit after each task. Branch is `real-money-rails`.

---

### Task 1: `ReadChainStatus` RPC adapter (`chain-status.ts`)

Reads the on-chain status of a sent withdrawal signature and maps it to the three states the confirmer understands. The mapping is pulled out as a pure function so it can be tested without a network.

**Files:**
- Create: `server/src/solana/chain-status.ts`
- Test: `server/src/solana/chain-status.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/solana/chain-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapSignatureStatus } from "./chain-status.js";

describe("mapSignatureStatus", () => {
  it("maps a finalized, error-free status to 'finalized'", () => {
    expect(mapSignatureStatus({ confirmationStatus: "finalized", err: null })).toBe("finalized");
  });

  it("maps any landed error to 'failed' (even if finalized)", () => {
    expect(mapSignatureStatus({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } })).toBe("failed");
    expect(mapSignatureStatus({ confirmationStatus: "confirmed", err: { foo: 1 } })).toBe("failed");
  });

  it("maps not-yet-finalized / missing status to 'unknown'", () => {
    expect(mapSignatureStatus({ confirmationStatus: "confirmed", err: null })).toBe("unknown");
    expect(mapSignatureStatus({ confirmationStatus: "processed", err: null })).toBe("unknown");
    expect(mapSignatureStatus(null)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/solana/chain-status.test.ts`
Expected: FAIL — `mapSignatureStatus` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

`server/src/solana/chain-status.ts`:

```ts
import { createSolanaRpc, type Signature } from "@solana/kit";
import type { ReadChainStatus, ChainStatus } from "../services/withdraw-worker.js";

/** Shape of one `getSignatureStatuses` value entry we care about. */
export interface SignatureStatusValue {
  confirmationStatus: string | null;
  err: unknown;
}

/**
 * Pure mapping from a `getSignatureStatuses` entry to the withdrawal confirmer's state.
 * A landed error is `failed` regardless of confirmation level (funds did not move).
 * Only an error-free `finalized` is `finalized`; everything else is `unknown` (poll again).
 */
export function mapSignatureStatus(value: SignatureStatusValue | null): ChainStatus {
  if (!value) return "unknown";
  if (value.err != null) return "failed";
  if (value.confirmationStatus === "finalized") return "finalized";
  return "unknown";
}

/** RPC-backed `ReadChainStatus` over `getSignatureStatuses` (searches recent + history). */
export function makeRpcChainStatusReader(rpcUrl: string): ReadChainStatus {
  const rpc = createSolanaRpc(rpcUrl);
  return async (txSig: string) => {
    const res = await rpc
      .getSignatureStatuses([txSig as Signature], { searchTransactionHistory: true })
      .send();
    const value = (res.value?.[0] ?? null) as SignatureStatusValue | null;
    return mapSignatureStatus(value);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/solana/chain-status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/solana/chain-status.ts server/src/solana/chain-status.test.ts
git commit -m "feat(withdraw): getSignatureStatuses chain-status adapter"
```

---

### Task 2: Treasury `WithdrawSigner` (`treasury-signer.ts`)

Implements the existing `WithdrawSigner` port: builds a treasury→user `transferChecked`, signs it with the local treasury keypair (one key covers the authority + fee-payer slots), and broadcasts it. Split into a keypair-injected core (unit-testable, no network) and an RPC-backed constructor — mirroring `fee-payer-signer.ts` / `signed-tx-broadcaster.ts`.

**Files:**
- Create: `server/src/solana/treasury-signer.ts`
- Test: `server/src/solana/treasury-signer.test.ts`
- Reference (do not modify): `server/src/solana/transfer-tx.ts`, `server/src/solana/fee-payer-signer.ts`, `server/src/services/withdraw-worker.ts`

- [ ] **Step 1: Write the failing test**

`server/src/solana/treasury-signer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  address,
  compileTransaction,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { buildTransferCheckedMessage } from "./transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";
import { centsToBaseUnits } from "../money/usdc.js";
import { makeTreasuryWithdrawSignerFromKeyPair } from "./treasury-signer.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TREASURY_USDC_ATA = "HutoZ391UtsKTwo5xdjZxmgRLKmRAMFPMhtcNTxQgtdF";
const BLOCKHASH = {
  blockhash: "11111111111111111111111111111111" as never,
  lastValidBlockHeight: 10n,
};

describe("makeTreasuryWithdrawSignerFromKeyPair", () => {
  it("builds the exact treasury→dest transferChecked, signs the treasury slot, and broadcasts it", async () => {
    const treasury = await generateKeyPairSigner();
    const destOwner = await generateKeyPairSigner();
    const sendTransaction = vi.fn(async () => "STUB_TX_SIG");

    const signer = makeTreasuryWithdrawSignerFromKeyPair(treasury.keyPair, {
      treasuryOwner: treasury.address,
      treasuryUsdcAta: TREASURY_USDC_ATA,
      usdcMint: USDC_MINT,
      getLatestBlockhash: async () => BLOCKHASH,
      sendTransaction,
    });

    const out = await signer.signAndSend({
      destWallet: destOwner.address,
      amountCents: 250, // $2.50
      idempotencyKey: "withdraw:test-id",
    });

    expect(out).toEqual({ txSig: "STUB_TX_SIG", providerTxId: null });
    expect(sendTransaction).toHaveBeenCalledTimes(1);

    // The broadcast payload must be the SAME message we'd build independently from the inputs
    // (proves source = treasury ATA, dest = derived dest ATA, amount = base units, decimals = 6),
    // and the treasury slot must be signed.
    const [destAta] = await findAssociatedTokenPda({
      owner: destOwner.address,
      mint: address(USDC_MINT),
      tokenProgram: address(LEGACY_TOKEN_PROGRAM),
    });
    const expectedWire = getBase64EncodedWireTransaction(
      compileTransaction(
        buildTransferCheckedMessage({
          source: address(TREASURY_USDC_ATA),
          mint: address(USDC_MINT),
          destination: destAta,
          authority: treasury.address,
          feePayer: treasury.address,
          amount: centsToBaseUnits(250n),
          decimals: 6,
          lifetime: BLOCKHASH,
        }),
      ),
    );

    const sentBase64 = sendTransaction.mock.calls[0][0] as string;
    const sentMsg = getTransactionDecoder().decode(Buffer.from(sentBase64, "base64"));
    const expectedMsg = getTransactionDecoder().decode(Buffer.from(expectedWire, "base64"));
    expect(Buffer.compare(Buffer.from(sentMsg.messageBytes), Buffer.from(expectedMsg.messageBytes))).toBe(0);
    expect(sentMsg.signatures[treasury.address]).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/solana/treasury-signer.test.ts`
Expected: FAIL — module/`makeTreasuryWithdrawSignerFromKeyPair` not found.

- [ ] **Step 3: Write minimal implementation**

`server/src/solana/treasury-signer.ts`:

```ts
/**
 * Self-custody treasury withdraw signer (real-money rails, spec §6 / money-rails-3).
 *
 * Implements the {@link WithdrawSigner} port: builds a treasury→user `transferChecked`,
 * signs it with the LOCAL treasury keypair, and broadcasts it. The treasury owner is BOTH
 * the source-ATA authority and the fee payer, so one keypair fills both signer slots.
 *
 * There is no provider-side idempotency key (a local keypair has none). Exactly-once is the
 * caller's DB state machine: `approveAndSend` claims `awaiting_approval → signing` as a
 * single-row conditional update, and a `sent` row is never re-sent. `idempotencyKey` is
 * accepted to satisfy the port but is not used for dedup here.
 *
 * Split (mirrors fee-payer-signer.ts): a keypair-injected core for unit tests + an
 * RPC-backed constructor for production.
 */
import {
  address,
  type Address,
  type Base64EncodedWireTransaction,
  type BlockhashLifetimeConstraint,
  assertIsFullySignedTransaction,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { buildTransferCheckedMessage } from "./transfer-tx.js";
import { parseFeePayerSecret } from "./fee-payer-signer.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";
import { USDC_DECIMALS, centsToBaseUnits } from "../money/usdc.js";
import type { WithdrawSigner } from "../services/withdraw-worker.js";

export interface TreasurySignerDeps {
  /** Treasury token authority = fee payer (the keypair's own address). */
  treasuryOwner: string;
  /** Treasury USDC ATA (the transfer source). */
  treasuryUsdcAta: string;
  /** USDC mint. */
  usdcMint: string;
  /** Fresh recent-blockhash lifetime (reuse `makeRpcBlockhash`). */
  getLatestBlockhash: () => Promise<BlockhashLifetimeConstraint>;
  /** Broadcast a base64 wire tx, returning the signature. */
  sendTransaction: (wireBase64: string) => Promise<string>;
}

export function makeTreasuryWithdrawSignerFromKeyPair(
  keyPair: CryptoKeyPair,
  deps: TreasurySignerDeps,
): WithdrawSigner {
  const mint = address(deps.usdcMint);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);
  const source = address(deps.treasuryUsdcAta);
  const authority = address(deps.treasuryOwner);

  return {
    async signAndSend({ destWallet, amountCents }) {
      const [destination] = await findAssociatedTokenPda({
        owner: address(destWallet),
        mint,
        tokenProgram,
      });
      const lifetime = await deps.getLatestBlockhash();
      const message = buildTransferCheckedMessage({
        source,
        mint,
        destination,
        authority, // reserved as a signer slot by the builder
        feePayer: authority, // treasury pays its own SOL fee
        amount: centsToBaseUnits(BigInt(amountCents)),
        decimals: USDC_DECIMALS,
        lifetime,
      });
      const signed = await partiallySignTransaction([keyPair], compileTransaction(message));
      assertIsFullySignedTransaction(signed);
      const txSig = await deps.sendTransaction(getBase64EncodedWireTransaction(signed));
      return { txSig, providerTxId: null };
    },
  };
}

/**
 * RPC-backed treasury signer from a secret (JSON byte array or base64, like FEE_PAYER_SECRET).
 * Exposes `.address` so boot can assert it equals the configured TREASURY_OWNER_PUBKEY.
 */
export async function makeTreasuryWithdrawSigner(
  secret: string,
  cfg: { rpcUrl: string; treasuryUsdcAta: string; usdcMint: string; getLatestBlockhash: () => Promise<BlockhashLifetimeConstraint> },
): Promise<WithdrawSigner & { address: string }> {
  const signer = await createKeyPairSignerFromBytes(parseFeePayerSecret(secret), false);
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const core = makeTreasuryWithdrawSignerFromKeyPair(signer.keyPair, {
    treasuryOwner: signer.address,
    treasuryUsdcAta: cfg.treasuryUsdcAta,
    usdcMint: cfg.usdcMint,
    getLatestBlockhash: cfg.getLatestBlockhash,
    sendTransaction: (wireBase64) =>
      rpc.sendTransaction(wireBase64 as Base64EncodedWireTransaction, { encoding: "base64" }).send(),
  });
  return { address: signer.address, signAndSend: core.signAndSend };
}

/** Re-export for call sites validating address strings. */
export { address };
export type { Address };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/solana/treasury-signer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/solana/treasury-signer.ts server/src/solana/treasury-signer.test.ts
git commit -m "feat(withdraw): self-custody treasury WithdrawSigner"
```

---

### Task 3: Env vars (`TREASURY_SECRET`, `WITHDRAW_POLL_MS`)

Add the two new env vars. `TREASURY_SECRET` is the optional treasury keypair secret; `WITHDRAW_POLL_MS` tunes the confirmer poll loop. No cross-field refinement is required (an unset `TREASURY_SECRET` simply leaves the send-leg disabled).

**Files:**
- Modify: `server/src/env.ts:39` (add fields to `EnvShape`)
- Test: `server/src/env.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `server/src/env.test.ts` (if it already exists, append the `describe` block):

```ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("env withdraw send-leg vars", () => {
  it("defaults WITHDRAW_POLL_MS and leaves TREASURY_SECRET undefined", () => {
    const e = parseEnv({});
    expect(e.WITHDRAW_POLL_MS).toBe(4000);
    expect(e.TREASURY_SECRET).toBeUndefined();
  });

  it("accepts a provided TREASURY_SECRET and WITHDRAW_POLL_MS", () => {
    const e = parseEnv({ TREASURY_SECRET: "[1,2,3]", WITHDRAW_POLL_MS: "1500" });
    expect(e.TREASURY_SECRET).toBe("[1,2,3]");
    expect(e.WITHDRAW_POLL_MS).toBe(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL — `WITHDRAW_POLL_MS` is `undefined` (not yet defined).

- [ ] **Step 3: Add the fields**

In `server/src/env.ts`, inside `EnvShape`, immediately after the `WITHDRAW_QUORUM_THRESHOLD_CENTS` line (`server/src/env.ts:39`), add:

```ts
  TREASURY_SECRET: z.string().min(1).optional(),
  WITHDRAW_POLL_MS: z.coerce.number().int().positive().default(4000),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/env.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/env.ts server/src/env.test.ts
git commit -m "feat(withdraw): add TREASURY_SECRET + WITHDRAW_POLL_MS env"
```

---

### Task 4: Withdraw confirmer poll loop (`withdraw-confirm-loop.ts`)

`makeWithdrawConfirmer` (in `withdraw-worker.ts`) only exposes a per-id `confirm(id)`. This loop drives it: on each tick it lists the ids of `sent` withdrawals and confirms each. It depends on an injected `listSentIds` so it stays unit-testable without a database; the real Drizzle query is wired in Task 5.

**Files:**
- Create: `server/src/services/withdraw-confirm-loop.ts`
- Test: `server/src/services/withdraw-confirm-loop.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/services/withdraw-confirm-loop.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeWithdrawConfirmLoop } from "./withdraw-confirm-loop.js";

describe("makeWithdrawConfirmLoop", () => {
  it("confirms every sent id on a tick", async () => {
    const confirm = vi.fn(async () => "confirmed" as const);
    const loop = makeWithdrawConfirmLoop({
      listSentIds: async () => ["a", "b", "c"],
      confirmer: { confirm },
      pollMs: 1000,
    });

    await loop.tick();

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenCalledWith("a");
    expect(confirm).toHaveBeenCalledWith("b");
    expect(confirm).toHaveBeenCalledWith("c");
  });

  it("does not throw when one id's confirm rejects (isolates failures)", async () => {
    const confirm = vi.fn(async (id: string) => {
      if (id === "b") throw new Error("rpc down");
      return "confirmed" as const;
    });
    const loop = makeWithdrawConfirmLoop({
      listSentIds: async () => ["a", "b", "c"],
      confirmer: { confirm },
      pollMs: 1000,
    });

    await expect(loop.tick()).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/withdraw-confirm-loop.test.ts`
Expected: FAIL — module/`makeWithdrawConfirmLoop` not found.

- [ ] **Step 3: Write minimal implementation**

`server/src/services/withdraw-confirm-loop.ts`:

```ts
/**
 * Poll loop that drives the per-id withdraw confirmer over all `sent` withdrawals
 * (mirrors makeDepositConfirmer's start/stop shape). One slow/failed id never blocks
 * the others: each confirm is awaited in isolation and its rejection is swallowed
 * (the row stays `sent` and is retried next tick).
 */
export interface WithdrawConfirmLoopDeps {
  /** Ids of withdrawals currently in status `sent`. */
  listSentIds: () => Promise<string[]>;
  /** The confirmer from makeWithdrawConfirmer. */
  confirmer: { confirm: (id: string) => Promise<"confirmed" | "reversed" | "needs_review" | "skip"> };
  pollMs: number;
}

export function makeWithdrawConfirmLoop(deps: WithdrawConfirmLoopDeps) {
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    const ids = await deps.listSentIds();
    for (const id of ids) {
      await deps.confirmer.confirm(id).catch(() => {});
    }
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), deps.pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/withdraw-confirm-loop.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/withdraw-confirm-loop.ts server/src/services/withdraw-confirm-loop.test.ts
git commit -m "feat(withdraw): poll loop driving the withdraw confirmer"
```

---

### Task 5: Wire the send-leg into `index.ts`

Construct the signer/processor/confirmer when `TREASURY_SECRET` is set, assert the derived address matches `TREASURY_OWNER_PUBKEY`, pass `withdrawProcessor` to `buildServer` (currently hard-coded `null`), and start the confirmer loop under `RUN_CONFIRMER`. `payoutSigner` stays `null` (explicit-withdrawals-only). When `TREASURY_SECRET` is unset, nothing changes.

**Files:**
- Modify: `server/src/index.ts` (imports; the `REAL_MONEY_ENABLED` block ~lines 87–95; the `buildServer({ ... })` call line 140)

- [ ] **Step 1: Add imports**

At the top of `server/src/index.ts`, with the other imports, add:

```ts
import { eq } from "drizzle-orm";
import { withdrawals } from "./db/schema.js";
```

- [ ] **Step 2: Build the send-leg after `withdrawalsSvc` is created**

In `server/src/index.ts`, inside the `if (env.REAL_MONEY_ENABLED) { ... }` block, replace the trailing comment (currently):

```ts
    // withdrawProcessor stays null until the payout signer is reintroduced in a later task.
    // The admin-approve endpoint 404s until then.
  }
```

with:

```ts
    // Self-custody send-leg: enabled only when a treasury keypair secret is configured.
    // Unset => withdrawProcessor stays null and the admin-approve endpoint 404s (unchanged).
    if (env.TREASURY_SECRET) {
      const { makeTreasuryWithdrawSigner } = await import("./solana/treasury-signer.js");
      const treasurySigner = await makeTreasuryWithdrawSigner(env.TREASURY_SECRET, {
        rpcUrl: env.SOLANA_RPC_URL!,
        treasuryUsdcAta: env.TREASURY_USDC_ATA!,
        usdcMint: env.USDC_MINT!,
        getLatestBlockhash: makeRpcBlockhash(env.SOLANA_RPC_URL!),
      });
      if (treasurySigner.address !== env.TREASURY_OWNER_PUBKEY) {
        throw new Error("TREASURY_OWNER_PUBKEY does not match TREASURY_SECRET");
      }
      const { makeWithdrawProcessor, makeWithdrawConfirmer } = await import("./services/withdraw-worker.js");
      withdrawProcessor = makeWithdrawProcessor(db, treasurySigner);

      if (env.RUN_CONFIRMER) {
        const { makeRpcChainStatusReader } = await import("./solana/chain-status.js");
        const { makeWithdrawConfirmLoop } = await import("./services/withdraw-confirm-loop.js");
        const confirmer = makeWithdrawConfirmer(db, ledger, makeRpcChainStatusReader(env.SOLANA_RPC_URL!));
        const loop = makeWithdrawConfirmLoop({
          confirmer,
          pollMs: env.WITHDRAW_POLL_MS,
          listSentIds: async () =>
            (await db.select({ id: withdrawals.id }).from(withdrawals).where(eq(withdrawals.status, "sent"))).map(
              (r: { id: string }) => r.id,
            ),
        });
        loop.start();
      }
    }
  }
```

- [ ] **Step 3: Declare `withdrawProcessor` alongside the other `let` bindings**

In `server/src/index.ts`, next to `let payoutSigner: WithdrawSigner | null = null;` (line 40), add:

```ts
  let withdrawProcessor: import("./services/withdraw-worker.js").WithdrawProcessor | null = null;
```

- [ ] **Step 4: Pass it to `buildServer`**

In the `buildServer({ ... })` call, change line 140 from:

```ts
    withdrawProcessor: null,
```

to:

```ts
    withdrawProcessor,
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `db.select(...).map` types complain, the explicit `(r: { id: string })` annotation in Step 2 resolves it.)

- [ ] **Step 6: Full test suite (no regressions)**

Run: `npx vitest run`
Expected: all tests pass (existing + the new Task 1–4 tests).

- [ ] **Step 7: Boot smoke test with the send-leg OFF (default)**

With `TREASURY_SECRET` unset, confirm nothing broke:

Run: `npx tsc --noEmit && echo "OK: compiles; TREASURY_SECRET unset => withdrawProcessor stays null, approve endpoint 404s as before"`
Expected: prints OK. (No DB/RPC needed for this check.)

- [ ] **Step 8: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(withdraw): wire treasury signer + confirmer loop under TREASURY_SECRET"
```

---

### Task 6: Devnet end-to-end verification (manual runbook)

The send-leg moves real (devnet) USDC, so it cannot be a unit test. This is a documented manual run that proves reserve → approve → sign → send → confirm actually moves devnet USDC and the `cash` ledger reconciles. **Do not run against mainnet.** Record the outcome at the bottom of this plan.

**Prerequisites (operator performs):**
- A throwaway **devnet** treasury keypair (e.g. `solana-keygen new -o /tmp/devnet-treasury.json`), its pubkey, and its **devnet USDC ATA** funded with devnet USDC.
- A throwaway **destination** wallet that already has a devnet USDC ATA.
- A reachable Postgres (`DATABASE_URL`) for the server.

- [ ] **Step 1: Configure a devnet env**

Set (do not commit secrets):

```bash
export REAL_MONEY_ENABLED=true
export SOLANA_CLUSTER=devnet
export SOLANA_RPC_URL=https://api.devnet.solana.com
export USDC_MINT=<devnet-usdc-mint>
export TREASURY_USDC_ATA=<devnet-treasury-ata>
export TREASURY_OWNER_PUBKEY=<devnet-treasury-pubkey>
export TREASURY_SECRET="$(cat /tmp/devnet-treasury.json)"   # JSON byte array
export DEV_ENDPOINTS=true
export RUN_CONFIRMER=true
export WITHDRAW_MAX_CENTS=500
export DATABASE_URL=<your-devnet-postgres-url>
```

- [ ] **Step 2: Boot and confirm the send-leg is live**

Run (from `server/`): `npx tsx watch src/index.ts`
Expected: logs `perps server listening on ...`, no `TREASURY_OWNER_PUBKEY does not match` throw. (A mismatch crash here is the boot assertion working — fix the env and retry.)

- [ ] **Step 3: Create a session + give the test user withdrawable `cash`**

Use the existing dev endpoints to create/authenticate a user, bind the destination wallet, and seed `cash` (e.g. via the dev faucet / deposit path you already use for testing). Note the session token and that the user's `walletPublicKey` is the destination wallet.

- [ ] **Step 4: Reserve a withdrawal**

```bash
curl -sS -X POST localhost:8080/v1/withdraw \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"amountCents":200}'
```
Expected: `{"withdrawalId":"<uuid>","state":"awaiting_approval"}` (after the hold; with `WITHDRAW_HOLD_HOURS=0` for the test). Capture `<uuid>`.

- [ ] **Step 5: Approve (admin) → triggers sign + broadcast**

```bash
curl -sS -X POST "localhost:8080/v1/admin/withdraw/<uuid>/approve" \
  -H "authorization: Bearer $TOKEN"
```
Expected: `{"status":"sent"}`. The server now has a `sent` row with a `txSig`.

- [ ] **Step 6: Verify on-chain + ledger reconciliation**

- Watch the server logs / poll: within a few `WITHDRAW_POLL_MS` cycles the row transitions `sent → confirmed`.
- Confirm on a devnet explorer that `<txSig>` moved 2.00 devnet USDC from the treasury ATA to the destination ATA.
- Verify the user's `cash` was debited exactly once (the reserve debit) and **not** re-credited.

Expected: USDC moved; withdrawal `confirmed`; ledger balanced.

- [ ] **Step 7: Negative path — forced failure reverses cleanly**

Reserve another withdrawal to an amount/destination that will fail on-chain (e.g. a destination wallet with **no** USDC ATA), approve it, and confirm the confirmer transitions it `sent → reversed` and re-credits `cash` exactly once.

Expected: row `reversed`; `cash` restored; net zero movement.

- [ ] **Step 8: Record the result**

Append a short "Devnet verification — <date>" note (txSigs, outcomes) to the bottom of this plan and commit it.

```bash
git add docs/superpowers/plans/2026-06-25-money-rails-3-withdraw-signer.md
git commit -m "docs(withdraw): record devnet end-to-end verification"
```

---

## Notes / out of scope (carried from spec)

- `payoutSigner` is intentionally left `null` — round wins are not auto-pushed on-chain; users withdraw explicitly.
- Not built here: real four-eyes admin auth on the approve endpoint (currently dev-gated), cold/hot key split, OFAC screening, `signing`-stuck auto-sweep, idempotent dest-ATA creation, multi-replica worker coordination.
- Mainnet cutover is operator-performed and out of this plan; it depends on access to whatever currently custodies the treasury funds (the Privy treasury).
