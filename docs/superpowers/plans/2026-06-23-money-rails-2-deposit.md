# Money Rails — Plan 2: Deposit (watch-and-credit) + Treasury config

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit a user's withdrawable `cash` balance when they send USDC from their bound embedded wallet to the treasury address — by watching the chain and validating each inbound transfer, with no treasury signing and no Privy staging app required.

**Architecture:** A polling confirmer reads finalized inbound USDC transfers to the treasury's USDC ATA through a swappable `DepositSource` port (real impl = `@solana/kit` RPC; tests = a fake). Each transfer is validated (finalized · dest ATA · USDC mint · legacy SPL program · whole-cents · in-bounds), attributed to a user by `sourceOwner === users.wallet_public_key`, and credited to `cash` idempotently on the tx signature. Everything money-moving is gated behind `REAL_MONEY_ENABLED` and fails closed. This is the spec's §5.4 confirmer + §8 reconciliation *minus* the server-authored-sponsorship layer (§5.1–5.3) — the hardened validation carries over intact.

**Tech Stack:** Fastify 5 · Drizzle ORM (Postgres / PGlite) · Zod · `@solana/kit` v2 (`createSolanaRpc`) · `@solana-program/token` · Vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-real-money-rails-design.md` (§4 data model, §5 deposit, §8 reconciliation, §10 anti-abuse, §11 config). **Builds on:** Plan 1 (cash/coin seam, committed) + the foundation primitives `money/usdc.ts`, `solana/transfer-tx.ts` (committed `cae85d2`).

**Out of scope (later plans):** withdraw / treasury signing (Plan 3, staging-gated); the two-RPC money-in quorum + delayed re-verify (§5.4 open-Q — single finalized RPC for v1, idempotency is the safety net); treasury-sponsored deposit gas; full multi-replica lease worker (deposit's `UNIQUE(tx_sig)` + idempotent credit make double-processing harmless, so the lease model is deferred to the money-OUT worker where it matters).

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/env.ts` (modify) | Add `REAL_MONEY_ENABLED` + Solana/treasury/deposit config, fail-closed when enabled |
| `server/src/solana/constants.ts` (create) | Chain constants (legacy SPL Token program address) |
| `server/src/db/schema.ts` (modify) | `deposits` + `deposit_sources` tables |
| `server/drizzle/0006_*.sql` (generate) | Migration for the two tables |
| `server/src/solana/mint-assert.ts` (create) | Boot assertion: USDC mint has 6 decimals + legacy SPL owner |
| `server/src/solana/deposit-source.ts` (create) | `DepositSource` port + real `@solana/kit` RPC adapter |
| `server/src/services/deposits.ts` (create) | Validate + attribute + credit one inbound transfer (the unit-tested core) |
| `server/src/services/deposit-worker.ts` (create) | Polling confirmer (`tick`/`start`/`stop`) over the `DepositSource` |
| `server/src/services/reconcile.ts` (create) | Solvency read: on-chain treasury USDC `O` vs ledger `cash` `L` |
| `server/src/http/routes.ts` (modify) | `GET /v1/deposit/address` (authed) returns treasury address + bound wallet |
| `server/src/index.ts` (modify) | Boot mint-assert + start confirmer, both behind `REAL_MONEY_ENABLED` |

**Test files:** `deposits.test.ts`, `deposit-worker.test.ts`, `mint-assert.test.ts`, `reconcile.test.ts` (co-located), plus an env test in `src/test/`.

---

## Task 1: Config / env (fail-closed when real money is on)

**Files:**
- Modify: `server/src/env.ts`
- Test: `server/src/test/env.real-money.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/test/env.real-money.test.ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

const base = { DATABASE_URL: "postgres://x" };

describe("real-money env gating", () => {
  it("defaults REAL_MONEY_ENABLED off and leaves Solana config optional", () => {
    const e = parseEnv({ ...base } as any);
    expect(e.REAL_MONEY_ENABLED).toBe(false);
    expect(e.DEPOSIT_MIN_CENTS).toBe(100);
    expect(e.DEPOSIT_MAX_CENTS).toBe(500);
  });

  it("THROWS when real money is on but Solana config is missing (fail closed)", () => {
    expect(() => parseEnv({ ...base, REAL_MONEY_ENABLED: "true" } as any)).toThrow(/SOLANA_RPC_URL|USDC_MINT|TREASURY_USDC_ATA/);
  });

  it("parses a fully-configured real-money env", () => {
    const e = parseEnv({
      ...base, REAL_MONEY_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example/devnet",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      TREASURY_USDC_ATA: "9wFF1111111111111111111111111111111111111111",
    } as any);
    expect(e.REAL_MONEY_ENABLED).toBe(true);
    expect(e.SOLANA_CLUSTER).toBe("mainnet-beta");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`REAL_MONEY_ENABLED` not on the parsed type).
Run: `cd server && npx vitest run src/test/env.real-money.test.ts`

- [ ] **Step 3: Implement** — add to the `Env` zod object in `server/src/env.ts` (after the `DEV_AUTH` field, before the closing `})`), then add a `.superRefine`:

```ts
  REAL_MONEY_ENABLED: z.string().optional().transform((v) => v === "true"),
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_URL_FALLBACK: z.string().url().optional(),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet"]).default("mainnet-beta"),
  USDC_MINT: z.string().min(32).optional(),
  TREASURY_USDC_ATA: z.string().min(32).optional(),
  TREASURY_OWNER_PUBKEY: z.string().min(32).optional(),
  DEPOSIT_MIN_CENTS: z.coerce.number().int().positive().default(100), // $1.00
  DEPOSIT_MAX_CENTS: z.coerce.number().int().positive().default(500), // $5.00
  DEPOSIT_POLL_MS: z.coerce.number().int().positive().default(8000),
  RUN_CONFIRMER: z.string().optional().default("true").transform((v) => v !== "false"),
```

Change `const Env = z.object({ ... });` to `const Env = z.object({ ... }).superRefine((e, ctx) => {...})`. Add the refinement just before `export type Env`:

```ts
const Env = EnvShape.superRefine((e, ctx) => {
  if (!e.REAL_MONEY_ENABLED) return;
  for (const k of ["SOLANA_RPC_URL", "USDC_MINT", "TREASURY_USDC_ATA"] as const) {
    if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when REAL_MONEY_ENABLED=true` });
  }
});
```

Rename the existing `z.object({...})` literal to `const EnvShape = z.object({...});` and keep `const Env = EnvShape.superRefine(...)`. `parseEnv`/`env` stay as-is (`Env.parse`).

- [ ] **Step 4: Run it — expect PASS.** Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**
```bash
git add server/src/env.ts server/src/test/env.real-money.test.ts
git commit -m "feat(server): real-money + Solana deposit config (fail-closed when enabled)"
```

---

## Task 2: `deposits` + `deposit_sources` tables

**Files:**
- Modify: `server/src/db/schema.ts`
- Generate: `server/drizzle/0006_*.sql`

- [ ] **Step 1: Add the tables** to `server/src/db/schema.ts` (after the `ledgerEntries` block, before `inventory`). Note `amountBaseUnits` is `text` (exact BigInt, never a float), `amountCents` is nullable (null for sub-cent/dust quarantine), `sourceWallet` is globally unique (one funding wallet backs one account — spec §10 sybil):

```ts
/** deposit lifecycle: a confirmed credit, or a quarantined (recorded-not-credited) inbound transfer. */
export const depositStatus = pgEnum("deposit_status", ["credited", "quarantine"]);

/** one row per observed inbound USDC transfer to the treasury ATA (idempotent on tx_sig). */
export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txSig: text("tx_sig").notNull(),
    userId: uuid("user_id").references(() => users.id), // null when unattributed/quarantined
    amountBaseUnits: text("amount_base_units").notNull(), // exact USDC base units (BigInt as string)
    amountCents: bigint("amount_cents", { mode: "number" }), // null on dust/quarantine
    mint: text("mint").notNull(),
    sourceOwner: text("source_owner").notNull(),
    destAta: text("dest_ata").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    status: depositStatus("status").notNull(),
    reason: text("reason"), // quarantine reason, null when credited
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txSigIdx: uniqueIndex("deposits_tx_sig_idx").on(t.txSig),
    userIdx: index("deposits_user_idx").on(t.userId),
  }),
);
export type Deposit = typeof deposits.$inferSelect;

/** append-only record of confirmed funding wallets; a wallet may back at most ONE account. */
export const depositSources = pgTable(
  "deposit_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    sourceWallet: text("source_wallet").notNull(),
    firstSeenTxSig: text("first_seen_tx_sig").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceWalletIdx: uniqueIndex("deposit_sources_wallet_idx").on(t.sourceWallet),
  }),
);
export type DepositSourceRow = typeof depositSources.$inferSelect;
```

- [ ] **Step 2: Generate the migration**
Run: `cd server && npm run db:generate`
Expected: a new `server/drizzle/0006_*.sql` creating the `deposit_status` enum + both tables + indexes. Open it and confirm it only ADDs (no destructive change to existing tables).

- [ ] **Step 3: Verify it applies** (the test harness runs migrations on a fresh PGlite):
Run: `cd server && npx vitest run src/services/ledger.test.ts`
Expected: PASS (proves the new migration applies cleanly alongside the existing suite).

- [ ] **Step 4: Commit**
```bash
git add server/src/db/schema.ts server/drizzle/
git commit -m "feat(server): deposits + deposit_sources tables (idempotent on tx_sig; one wallet per account)"
```

---

## Task 3: Solana constants + USDC mint boot-assert

**Files:**
- Create: `server/src/solana/constants.ts`
- Create: `server/src/solana/mint-assert.ts`
- Test: `server/src/solana/mint-assert.test.ts`

- [ ] **Step 1: Create constants**
```ts
// server/src/solana/constants.ts
/** Legacy SPL Token program (NOT Token-2022) — the only token program we accept (spec §5). */
export const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
```

- [ ] **Step 2: Write the failing test** — the assert takes a tiny `MintInfo` port so it's testable without an RPC:
```ts
// server/src/solana/mint-assert.test.ts
import { describe, it, expect } from "vitest";
import { assertUsdcMint } from "./mint-assert.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

const ok = { decimals: 6, programAddress: LEGACY_TOKEN_PROGRAM };

describe("assertUsdcMint", () => {
  it("passes for a 6-decimal legacy-SPL mint", async () => {
    await expect(assertUsdcMint(async () => ok, "USDCmint")).resolves.toBeUndefined();
  });
  it("THROWS on wrong decimals", async () => {
    await expect(assertUsdcMint(async () => ({ ...ok, decimals: 9 }), "USDCmint")).rejects.toThrow(/decimals/i);
  });
  it("THROWS on Token-2022 / non-legacy program", async () => {
    await expect(assertUsdcMint(async () => ({ ...ok, programAddress: "Tokenz" }), "USDCmint")).rejects.toThrow(/legacy SPL|program/i);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (module missing).
Run: `cd server && npx vitest run src/solana/mint-assert.test.ts`

- [ ] **Step 4: Implement**
```ts
// server/src/solana/mint-assert.ts
import { USDC_DECIMALS } from "../money/usdc.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

export interface MintInfo { decimals: number; programAddress: string; }
/** A function that fetches on-chain mint info for a mint address. */
export type FetchMintInfo = (mint: string) => Promise<MintInfo>;

/** Boot guard (spec §5): refuse to run unless the configured USDC mint is 6-decimal legacy SPL. */
export async function assertUsdcMint(fetch: FetchMintInfo, mint: string): Promise<void> {
  const info = await fetch(mint);
  if (info.decimals !== USDC_DECIMALS) {
    throw new Error(`USDC mint ${mint} has ${info.decimals} decimals, expected ${USDC_DECIMALS}`);
  }
  if (info.programAddress !== LEGACY_TOKEN_PROGRAM) {
    throw new Error(`USDC mint ${mint} is not legacy SPL (program ${info.programAddress})`);
  }
}
```

- [ ] **Step 5: Run it — expect PASS.** Then commit:
```bash
git add server/src/solana/constants.ts server/src/solana/mint-assert.ts server/src/solana/mint-assert.test.ts
git commit -m "feat(server): USDC mint boot-assert (6 decimals + legacy SPL)"
```

---

## Task 4: `DepositSource` port + real `@solana/kit` RPC adapter

**Files:**
- Create: `server/src/solana/deposit-source.ts`

> This task's correctness against a live chain is validated in Task 7's devnet step (RPC response parsing can only be fully proven against a real RPC — the same class of check as Phase-0 staging item 11). The **port contract** below is what the confirmer (Task 5) depends on; the confirmer is fully unit-tested against a fake implementing this interface.

- [ ] **Step 1: Define the port + the parsed record** (this is the seam the confirmer is tested against):
```ts
// server/src/solana/deposit-source.ts
import { createSolanaRpc, address } from "@solana/kit";
import { fetchMint } from "@solana-program/token";
import type { InboundTransfer } from "../services/deposits.js";
import type { MintInfo } from "./mint-assert.js";

/** Reads finalized inbound USDC transfers to a treasury ATA, newest-first, stopping at `untilSig`. */
export interface DepositSource {
  fetchInbound(opts: { treasuryAta: string; untilSig?: string; limit?: number }): Promise<InboundTransfer[]>;
  fetchMintInfo(mint: string): Promise<MintInfo>;
}
```

- [ ] **Step 2: Implement the real adapter** with `@solana/kit`. (Step 3 of Task 7 runs this against devnet; the implementer verifies the exact `getTransaction` field shapes there and adjusts parsing if kit's response differs.)

```ts
export function makeRpcDepositSource(rpcUrl: string): DepositSource {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async fetchMintInfo(mint) {
      const m = await fetchMint(rpc as any, address(mint));
      return { decimals: m.data.decimals, programAddress: m.programAddress as string };
    },
    async fetchInbound({ treasuryAta, untilSig, limit = 100 }) {
      const sigs = await rpc
        .getSignaturesForAddress(address(treasuryAta), { until: untilSig as any, limit, commitment: "finalized" })
        .send();
      const out: InboundTransfer[] = [];
      for (const s of sigs) {
        if (s.err) continue; // landed-but-failed: no tokens moved
        const tx = await rpc
          .getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized", encoding: "jsonParsed" })
          .send();
        if (!tx) continue;
        const pre = tx.meta?.preTokenBalances ?? [];
        const post = tx.meta?.postTokenBalances ?? [];
        // find the treasury ATA's balance change by matching the account at the same index
        const keys = tx.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
        const ataIndex = keys.indexOf(treasuryAta);
        if (ataIndex < 0) continue;
        const preBal = pre.find((b: any) => b.accountIndex === ataIndex);
        const postBal = post.find((b: any) => b.accountIndex === ataIndex);
        if (!postBal) continue;
        const delta = BigInt(postBal.uiTokenAmount.amount) - BigInt(preBal?.uiTokenAmount.amount ?? "0");
        if (delta <= 0n) continue; // only inbound credits
        // source owner = owner of the non-treasury token account that DECREASED
        const source = pre.find((b: any) => {
          const matchPost = post.find((p: any) => p.accountIndex === b.accountIndex);
          return b.accountIndex !== ataIndex && matchPost && BigInt(matchPost.uiTokenAmount.amount) < BigInt(b.uiTokenAmount.amount);
        });
        out.push({
          txSig: s.signature,
          slot: Number(s.slot),
          finalized: true, // commitment:'finalized' was requested
          mint: postBal.mint,
          tokenProgram: postBal.programId ?? "",
          destAta: treasuryAta,
          sourceOwner: source?.owner ?? "",
          amountBaseUnits: delta,
        });
      }
      return out;
    },
  };
}
```

- [ ] **Step 3: Typecheck** (no unit test — covered by Task 7 devnet run):
Run: `cd server && npx tsc --noEmit`
Expected: clean. (If kit's RPC method names/option fields differ from the above, adjust to the installed `@solana/kit` types — `node_modules/@solana/kit` — until tsc passes.)

- [ ] **Step 4: Commit**
```bash
git add server/src/solana/deposit-source.ts
git commit -m "feat(server): DepositSource port + @solana/kit RPC adapter (validated on devnet in Task 7)"
```

---

## Task 5: Deposit confirmer service (validate · attribute · credit)

**Files:**
- Create: `server/src/services/deposits.ts`
- Test: `server/src/services/deposits.test.ts`

- [ ] **Step 1: Write the failing test** (uses the PGlite harness + the real ledger; drives `recordInbound` with synthetic transfers):
```ts
// server/src/services/deposits.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { depositSources } from "../db/schema.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";
const cfg = { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 };

function transfer(over: Partial<InboundTransfer> = {}): InboundTransfer {
  return {
    txSig: "sig1", slot: 10, finalized: true, mint: USDC, tokenProgram: LEGACY_TOKEN_PROGRAM,
    destAta: ATA, sourceOwner: "WALLET_A", amountBaseUnits: 2_000_000n, ...over, // $2.00
  };
}

describe("deposits.recordInbound", () => {
  let ctx: TestCtx;
  let deposits: ReturnType<typeof makeDeposits>;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
    deposits = makeDeposits(ctx.db, ctx.ledger, cfg);
  });
  afterEach(async () => { await ctx.close(); });

  it("credits cash for a valid transfer from a bound wallet", async () => {
    const r = await deposits.recordInbound(transfer());
    expect(r).toEqual({ status: "credited", userId, amountCents: 200 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(0); // seam intact
  });

  it("is idempotent — replaying the same tx_sig does not double-credit", async () => {
    await deposits.recordInbound(transfer());
    const again = await deposits.recordInbound(transfer());
    expect(again).toEqual({ status: "duplicate" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("quarantines sub-cent dust (never rounds)", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "d", amountBaseUnits: 2_000_001n }));
    expect(r).toEqual({ status: "quarantine", reason: "sub_cent_dust" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("quarantines wrong mint, wrong program, wrong dest, and out-of-bounds", async () => {
    expect((await deposits.recordInbound(transfer({ txSig: "m", mint: "OTHER" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "p", tokenProgram: "Tokenz" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "x", destAta: "ELSEWHERE" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "hi", amountBaseUnits: 9_999_999n }))).status).toBe("quarantine");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("quarantines a transfer from an unbound wallet (unknown source)", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "u", sourceOwner: "STRANGER" }));
    expect(r).toEqual({ status: "quarantine", reason: "unknown_source" });
  });

  it("a second deposit from the same wallet credits the same user; deposit_sources stays one row", async () => {
    await deposits.recordInbound(transfer());                            // sig1 → +200
    const r2 = await deposits.recordInbound(transfer({ txSig: "sig2" })); // new sig, same WALLET_A
    expect(r2).toEqual({ status: "credited", userId, amountCents: 200 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400);
    const rows = await ctx.db.select().from(depositSources).where(eq(depositSources.sourceWallet, "WALLET_A"));
    expect(rows).toHaveLength(1); // funding wallet bound exactly once
  });

  it("quarantines if the funding wallet is already bound to ANOTHER account (sybil guard)", async () => {
    const other = await ctx.users.upsertByExternalId("privy:did:privy:b");
    // seed an inconsistent binding: deposit_sources says WALLET_A backs `other`, but users maps it to userId
    await ctx.db.insert(depositSources).values({ userId: other.id, sourceWallet: "WALLET_A", firstSeenTxSig: "old" });
    const r = await deposits.recordInbound(transfer({ txSig: "syb" }));
    expect(r).toEqual({ status: "quarantine", reason: "source_bound_other" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0); // nothing credited
  });

  it("ignores a not-yet-finalized transfer without recording it", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "nf", finalized: false }));
    expect(r).toEqual({ status: "quarantine", reason: "not_finalized" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).
Run: `cd server && npx vitest run src/services/deposits.test.ts`

- [ ] **Step 3: Implement** `server/src/services/deposits.ts`:
```ts
import { eq } from "drizzle-orm";
import { deposits, depositSources, users } from "../db/schema.js";
import { baseUnitsToCents } from "../money/usdc.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import type { Ledger } from "./ledger.js";

export interface InboundTransfer {
  txSig: string;
  slot: number;
  finalized: boolean;
  mint: string;
  tokenProgram: string;
  destAta: string;
  sourceOwner: string;
  amountBaseUnits: bigint;
}

export interface DepositsConfig {
  usdcMint: string;
  treasuryAta: string;
  minCents: number;
  maxCents: number;
}

export type DepositOutcome =
  | { status: "credited"; userId: string; amountCents: number }
  | { status: "duplicate" }
  | { status: "quarantine"; reason: string };

export function makeDeposits(db: any, ledger: Ledger, cfg: DepositsConfig) {
  async function quarantine(t: InboundTransfer, reason: string, cents: number | null, userId: string | null): Promise<DepositOutcome> {
    await db.insert(deposits).values({
      txSig: t.txSig, userId, amountBaseUnits: t.amountBaseUnits.toString(), amountCents: cents,
      mint: t.mint, sourceOwner: t.sourceOwner, destAta: t.destAta, slot: t.slot,
      status: "quarantine", reason,
    }).onConflictDoNothing();
    return { status: "quarantine", reason };
  }

  return {
    async recordInbound(t: InboundTransfer): Promise<DepositOutcome> {
      if (!t.finalized) return { status: "quarantine", reason: "not_finalized" }; // re-seen once finalized; not recorded
      if (t.destAta !== cfg.treasuryAta) return quarantine(t, "wrong_dest", null, null);
      if (t.mint !== cfg.usdcMint) return quarantine(t, "wrong_mint", null, null);
      if (t.tokenProgram !== LEGACY_TOKEN_PROGRAM) return quarantine(t, "wrong_program", null, null);

      let cents: number;
      try { cents = Number(baseUnitsToCents(t.amountBaseUnits)); }
      catch { return quarantine(t, "sub_cent_dust", null, null); }
      if (cents < cfg.minCents || cents > cfg.maxCents) return quarantine(t, "out_of_bounds", cents, null);

      const found = await db.select().from(users).where(eq(users.walletPublicKey, t.sourceOwner)).limit(1);
      const user = found[0];
      if (!user) return quarantine(t, "unknown_source", cents, null);

      const bound = await db.select().from(depositSources).where(eq(depositSources.sourceWallet, t.sourceOwner)).limit(1);
      if (bound[0] && bound[0].userId !== user.id) return quarantine(t, "source_bound_other", cents, user.id);

      return db.transaction(async (tx: any) => {
        const ins = await tx.insert(deposits).values({
          txSig: t.txSig, userId: user.id, amountBaseUnits: t.amountBaseUnits.toString(), amountCents: cents,
          mint: t.mint, sourceOwner: t.sourceOwner, destAta: t.destAta, slot: t.slot,
          status: "credited", reason: null,
        }).onConflictDoNothing().returning({ id: deposits.id });
        if (ins.length === 0) return { status: "duplicate" } as DepositOutcome; // tx_sig already processed
        await ledger.creditOn(tx, user.id, "cash", cents, "deposit", t.txSig);
        await tx.insert(depositSources).values({
          userId: user.id, sourceWallet: t.sourceOwner, firstSeenTxSig: t.txSig,
        }).onConflictDoNothing();
        return { status: "credited", userId: user.id, amountCents: cents } as DepositOutcome;
      });
    },
  };
}

export type Deposits = ReturnType<typeof makeDeposits>;
```

- [ ] **Step 4: Run it — expect PASS** (all 7). Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/deposits.ts server/src/services/deposits.test.ts
git commit -m "feat(server): deposit confirmer — validate, attribute by bound wallet, credit cash idempotently"
```

---

## Task 6: Polling confirmer worker

**Files:**
- Create: `server/src/services/deposit-worker.ts`
- Test: `server/src/services/deposit-worker.test.ts`

- [ ] **Step 1: Write the failing test** (drives `tick()` with a fake `DepositSource`; asserts it credits + advances its cursor):
```ts
// server/src/services/deposit-worker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { makeDepositConfirmer } from "./deposit-worker.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";

function tx(sig: string): InboundTransfer {
  return { txSig: sig, slot: 1, finalized: true, mint: USDC, tokenProgram: LEGACY_TOKEN_PROGRAM, destAta: ATA, sourceOwner: "WALLET_A", amountBaseUnits: 1_000_000n };
}

describe("makeDepositConfirmer.tick", () => {
  let ctx: TestCtx; let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
  });
  afterEach(async () => { await ctx.close(); });

  it("processes newest→oldest and credits each once, then advances its cursor", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    let pending = [tx("s2"), tx("s1")]; // source returns newest-first
    const source = {
      async fetchInbound({ untilSig }: { untilSig?: string }) {
        return untilSig === "s2" ? [] : pending;
      },
      async fetchMintInfo() { return { decimals: 6, programAddress: LEGACY_TOKEN_PROGRAM }; },
    };
    const confirmer = makeDepositConfirmer({ deposits, source, treasuryAta: ATA, pollMs: 1000 });
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200); // 2 × $1.00
    await confirmer.tick(); // cursor now at s2 → source returns [] → no double-credit
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `cd server && npx vitest run src/services/deposit-worker.test.ts`

- [ ] **Step 3: Implement** `server/src/services/deposit-worker.ts`:
```ts
import type { Deposits } from "./deposits.js";
import type { DepositSource } from "../solana/deposit-source.js";

export interface DepositConfirmerOpts {
  deposits: Deposits;
  source: DepositSource;
  treasuryAta: string;
  pollMs: number;
}

export function makeDepositConfirmer(opts: DepositConfirmerOpts) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor: string | undefined; // newest processed signature

  async function tick(): Promise<void> {
    const batch = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, untilSig: cursor });
    if (batch.length === 0) return;
    // process oldest→newest so a crash mid-batch leaves the cursor behind, never ahead
    for (const t of [...batch].reverse()) await opts.deposits.recordInbound(t);
    cursor = batch[0].txSig; // batch[0] is newest (source returns newest-first)
  }

  return {
    tick,
    start() {
      void tick().catch(() => {});
      timer = setInterval(() => void tick().catch(() => {}), opts.pollMs);
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
```

- [ ] **Step 4: Run it — expect PASS.** Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/deposit-worker.ts server/src/services/deposit-worker.test.ts
git commit -m "feat(server): polling deposit confirmer (cursor + idempotent credit)"
```

---

## Task 7: Deposit-address endpoint, solvency read, boot wiring + devnet verification

**Files:**
- Create: `server/src/services/reconcile.ts` + `server/src/services/reconcile.test.ts`
- Modify: `server/src/http/routes.ts`, `server/src/http/server.ts` (deps passthrough), `server/src/index.ts`

- [ ] **Step 1: Solvency read — failing test** (`O` from a treasury-balance reader vs `L` = Σ cash ledger):
```ts
// server/src/services/reconcile.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeReconcile } from "./reconcile.js";

describe("reconcile.solvency", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("reports O ≥ L solvent and O < L as a deficit", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.ledger.credit(u.id, "cash", 300, "deposit", "sig1"); // L = 300¢
    const solvent = makeReconcile(ctx.db, async () => 3_000_000n); // O = $3.00
    expect(await solvent.solvency()).toMatchObject({ ledgerCents: 300, onChainCents: 300, deficitCents: 0, healthy: true });
    const broke = makeReconcile(ctx.db, async () => 1_000_000n);   // O = $1.00
    expect(await broke.solvency()).toMatchObject({ ledgerCents: 300, onChainCents: 100, deficitCents: 200, healthy: false });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `cd server && npx vitest run src/services/reconcile.test.ts`

- [ ] **Step 3: Implement** `server/src/services/reconcile.ts`:
```ts
import { sql, eq } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";
import { baseUnitsToCents } from "../money/usdc.js";

/** Returns the treasury USDC ATA balance in base units. */
export type ReadTreasuryBaseUnits = () => Promise<bigint>;

export function makeReconcile(db: any, readTreasury: ReadTreasuryBaseUnits) {
  return {
    async solvency() {
      const rows = await db
        .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.asset, "cash"));
      const ledgerCents = Number(rows[0]?.bal ?? 0);
      const raw = await readTreasury();
      // on-chain may carry sub-cent dust; floor to whole cents for the comparison
      const onChainCents = Number(raw - (raw % 10_000n)) / 10_000;
      const deficitCents = Math.max(0, ledgerCents - onChainCents);
      return { ledgerCents, onChainCents, deficitCents, healthy: deficitCents === 0 };
    },
  };
}
```
(Imports `baseUnitsToCents` is not needed here — remove it; the floor is inline to tolerate dust. Keep the import list to `sql, eq` + `ledgerEntries` only.)

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Add the deposit-address endpoint.** In `server/src/http/routes.ts`, add to `RouteDeps`: `realMoney: { enabled: boolean; treasuryUsdcAta: string | null }`. Add this route inside `registerRoutes` (after `/v1/me`):
```ts
  server.get("/v1/deposit/address", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.realMoney.enabled || !deps.realMoney.treasuryUsdcAta) {
      return reply.code(404).send({ error: "deposits_disabled" });
    }
    const user = await deps.users.get(req.userId!);
    return {
      treasuryUsdcAta: deps.realMoney.treasuryUsdcAta,
      boundWallet: user?.walletPublicKey ?? null, // deposit MUST come from this wallet to be credited
      note: "send USDC from your bound wallet to treasuryUsdcAta; credited after on-chain finality",
    };
  });
```
Thread `realMoney` through `buildServer` (`server/src/http/server.ts`) like the other deps. Add a quick route test asserting 404 when disabled and the address payload when enabled (model it on the existing auth-route tests in `src/test/`).

- [ ] **Step 6: Wire boot** in `server/src/index.ts` (behind `REAL_MONEY_ENABLED`), after `const ledger = makeLedger(db);`:
```ts
  let depositConfirmer: { start(): void; stop(): void } | undefined;
  let realMoney = { enabled: false, treasuryUsdcAta: null as string | null };
  if (env.REAL_MONEY_ENABLED) {
    const { makeRpcDepositSource } = await import("./solana/deposit-source.js");
    const { assertUsdcMint } = await import("./solana/mint-assert.js");
    const { makeDeposits } = await import("./services/deposits.js");
    const { makeDepositConfirmer } = await import("./services/deposit-worker.js");
    const source = makeRpcDepositSource(env.SOLANA_RPC_URL!);
    await assertUsdcMint((m) => source.fetchMintInfo(m), env.USDC_MINT!); // refuse to boot on a bad mint
    const deposits = makeDeposits(db, ledger, {
      usdcMint: env.USDC_MINT!, treasuryAta: env.TREASURY_USDC_ATA!,
      minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
    });
    if (env.RUN_CONFIRMER) {
      depositConfirmer = makeDepositConfirmer({ deposits, source, treasuryAta: env.TREASURY_USDC_ATA!, pollMs: env.DEPOSIT_POLL_MS });
      depositConfirmer.start();
    }
    realMoney = { enabled: true, treasuryUsdcAta: env.TREASURY_USDC_ATA! };
  }
```
Pass `realMoney` into `buildServer({...})`. Add `depositConfirmer?.stop()` to any shutdown path if one exists (else leave — process exit clears the interval).

- [ ] **Step 7: Verify the whole suite + tsc.**
Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all green (the new deposit/worker/reconcile/env tests included), tsc clean.

- [ ] **Step 8: Devnet smoke (validates the Task-4 RPC adapter against a real chain — no funds at risk).**
Point `SOLANA_RPC_URL` at a devnet RPC, set `USDC_MINT`/`TREASURY_USDC_ATA` to a devnet 6-decimal SPL mint + a treasury ATA you control, send one small transfer from a bound wallet, and confirm a `deposits` row lands `credited` with the right `amount_cents` and the user's `cash` rises. Record the result. (This is the deposit-side analogue of Phase-0 staging item 11; it needs only a devnet RPC, not the Privy app.)

- [ ] **Step 9: Commit**
```bash
git add server/src/services/reconcile.ts server/src/services/reconcile.test.ts server/src/http/routes.ts server/src/http/server.ts server/src/index.ts
git commit -m "feat(server): deposit-address endpoint, solvency read, boot wiring (gated by REAL_MONEY_ENABLED)"
```

---

## Self-Review (run before execution)

- **Spec coverage:** §4 deposits/deposit_sources → T2; §5 confirmer validation (finalized · mint · program · dest · whole-cents · bounds) → T5; §5 boot mint-assert + BigInt scale → T3 + reuse of `money/usdc.ts`; §8 recognized-`O`-vs-`L` solvency → T7; §10 sybil one-wallet-per-account → T2 unique + T5 guard; §11 config/fail-closed → T1. **Deferred (documented):** §5.1–5.3 server-authored sponsorship (we chose watch-and-credit); §5.4 two-RPC quorum + delayed re-verify (open-Q; single finalized RPC + idempotency for v1); §7 multi-replica lease (harmless for deposit; belongs to the money-OUT worker).
- **Type consistency:** `InboundTransfer` is defined once in `services/deposits.ts` and imported by the port + worker; `recordInbound`/`fetchInbound`/`solvency` signatures match their call sites; ledger credit uses the committed `creditOn(tx, userId, "cash", cents, "deposit", txSig)`.
- **Placeholder scan:** every code step has complete code; the one genuinely chain-dependent piece (the RPC adapter's `getTransaction` parsing, T4) is explicitly validated in T7 step 8 against devnet, mirroring how Phase-0 handled un-typecheckable runtime behavior.
