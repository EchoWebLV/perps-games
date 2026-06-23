# Cash/Coin Ledger Seam + Identity Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compile-enforced `cash`/`coin` asset dimension to the off-chain ledger so real-USDC `cash` can never be spent/withdrawn as soft `coin`, and harden the wallet-binding so a deposit's source wallet is set-once and deterministic.

**Architecture:** Extend the existing append-only `ledgerEntries` table and `makeLedger()` service with a **required** `asset` parameter on every primitive (no default → every existing call site fails to compile until it declares `'coin'`). Balances, the per-user advisory lock, and the idempotency index all become asset-aware. `debitOn`/`creditOn` return a boolean "did it actually post" (so a later withdraw-reserve can gate an irreversible USDC send on it). `users.setWalletPublicKey` becomes set-once, and the embedded-Solana-wallet selection becomes a pure, deterministic, tested function.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM (`drizzle-orm@0.36`, `drizzle-kit@0.28`), Postgres / PGlite (tests), Vitest.

**This is Plan 1 of the real-money rails (spec: `docs/superpowers/specs/2026-06-23-real-money-rails-design.md`, §3, §3a, §4).** It has zero chain dependency and produces working, tested software on its own. Plan 0 (Privy/Solana capability spike), Plan 2 (deposit), Plan 3 (withdraw) follow.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `server/src/db/schema.ts` | modify | `ledgerEntries`: add `asset` enum+column; idempotency index → `(asset, reason, ref)`; add cash-ref CHECK |
| `server/drizzle/0005_*.sql` | generate | migration for the schema change (drizzle-kit) |
| `server/src/services/ledger.ts` | modify | required `asset` param; asset-filtered balance; asset in advisory lock; boolean returns; null-ref guard for cash reasons |
| `server/src/services/ledger.test.ts` | create | asset isolation, per-`(asset,reason,ref)` idempotency, boolean returns, null-ref throw, lock concurrency |
| `server/src/http/routes.ts` | modify | pass `"coin"` at the 6 existing ledger call sites |
| `server/src/services/rounds.ts` | modify | pass `"coin"` at the 2 existing ledger call sites |
| `server/src/services/users.ts` | modify | `setWalletPublicKey` → set-once compare-and-set |
| `server/src/services/users.test.ts` | modify | add set-once + idempotent-rebind tests |
| `server/src/auth/privy-wallet.ts` | create | pure `pickEmbeddedSolanaWallet()` (deterministic, alert on >1) |
| `server/src/auth/privy-wallet.test.ts` | create | tests for the picker |
| `server/src/auth/privy.ts` | modify | `fetchSolanaWallet` delegates to the pure picker |

Run all commands from `server/` unless noted.

---

### Task 1: Schema — add the `asset` dimension + migration

**Files:**
- Modify: `server/src/db/schema.ts:11` (import) and `:33-53` (ledgerEntries)
- Generate: `server/drizzle/0005_*.sql`

- [ ] **Step 1: Add the `check` import**

In `server/src/db/schema.ts`, the import block (lines 1-12) currently ends with `pgEnum,`. Add `check,`:

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  bigint,
  index,
  integer,
  doublePrecision,
  pgEnum,
  check,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Declare the asset enum**

Immediately above `export const ledgerEntries = pgTable(` (currently line 33), add:

```ts
/** ledger asset: soft play-money (faucet, never withdrawable) vs USDC-backed real money */
export const ledgerAsset = pgEnum("ledger_asset", ["coin", "cash"]);
```

- [ ] **Step 3: Add the `asset` column**

In the `ledgerEntries` column block, add the column right after `delta` (currently line 41):

```ts
    /** signed integer coins: credit > 0, debit < 0 */
    delta: bigint("delta", { mode: "number" }).notNull(),
    /** which money bucket. 'coin' = soft play money; 'cash' = USDC-backed, withdrawable. */
    asset: ledgerAsset("asset").notNull().default("coin"),
```

- [ ] **Step 4: Make the idempotency index asset-aware + add the cash-ref CHECK**

Replace the table's extra-config callback (currently lines 48-52) with:

```ts
  (t) => ({
    userIdx: index("ledger_user_idx").on(t.userId),
    // idempotency: a (asset, reason, ref) triple posts at most once (ref optional).
    idemIdx: uniqueIndex("ledger_idem_idx").on(t.asset, t.reason, t.ref).where(sql`${t.ref} is not null`),
    // cash-moving reasons MUST carry a ref (else one on-chain transfer could credit twice).
    cashRefChk: check(
      "ledger_cash_ref_chk",
      sql`${t.ref} is not null or ${t.reason} not in ('deposit','withdraw_reserve','withdraw_reverse')`,
    ),
  }),
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `server/drizzle/0005_<random>.sql` is created and `server/drizzle/meta/_journal.json` is updated. Open the generated SQL and confirm it contains (order may differ): `CREATE TYPE "ledger_asset"`, `ALTER TABLE "ledger_entries" ADD COLUMN "asset"`, the dropped+recreated `ledger_idem_idx` on `("asset","reason","ref")`, and the `ledger_cash_ref_chk` constraint.

**If the generated SQL is missing the column/index/check** (older drizzle-kit), replace the generated file's body with exactly this (the journal entry already references it):

```sql
CREATE TYPE "ledger_asset" AS ENUM('coin', 'cash');
ALTER TABLE "ledger_entries" ADD COLUMN "asset" "ledger_asset" DEFAULT 'coin' NOT NULL;
DROP INDEX IF EXISTS "ledger_idem_idx";
CREATE UNIQUE INDEX "ledger_idem_idx" ON "ledger_entries" ("asset","reason","ref") WHERE "ref" is not null;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_cash_ref_chk" CHECK ("ref" is not null or "reason" not in ('deposit','withdraw_reserve','withdraw_reverse'));
```

- [ ] **Step 6: Verify migrations apply cleanly (PGlite)**

Run: `npx vitest run src/services/users.test.ts`
Expected: PASS. (The existing test boots `makeTestDb()` → `runMigrations()`, which now applies 0005. Green = the migration is valid SQL.)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(server): add cash/coin asset dimension to ledger schema (+ asset-aware idem index, cash-ref CHECK)"
```

---

### Task 2: Ledger — required `asset` param, asset-filtered balance + lock, updated call sites

**Files:**
- Create: `server/src/services/ledger.test.ts`
- Modify: `server/src/services/ledger.ts` (full rewrite of the service body)
- Modify: `server/src/http/routes.ts:48,60,63,119,151,152`
- Modify: `server/src/services/rounds.ts:55,204`

- [ ] **Step 1: Write the failing asset-isolation test**

Create `server/src/services/ledger.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";

describe("ledger asset seam", () => {
  let ctx: TestCtx;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
  });
  afterEach(async () => { await ctx.close(); });

  it("keeps coin and cash balances separate", async () => {
    await ctx.ledger.credit(userId, "coin", 100, "dev_grant");
    await ctx.ledger.credit(userId, "cash", 500, "deposit", "tx-sig-1");
    expect(await ctx.ledger.balance(userId, "coin")).toBe(100);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("a coin balance is NOT spendable as cash (the faucet cannot be withdrawn)", async () => {
    await ctx.ledger.credit(userId, "coin", 10000, "signup_faucet", userId);
    await expect(
      ctx.ledger.debit(userId, "cash", 100, "withdraw_reserve", "wd-1"),
    ).rejects.toThrow(/insufficient balance/);
  });

  it("idempotency is per (asset, reason, ref): the same ref on different assets both post", async () => {
    expect(await ctx.ledger.credit(userId, "coin", 50, "promo", "ref-x")).toBe(true);
    expect(await ctx.ledger.credit(userId, "cash", 50, "promo", "ref-x")).toBe(true);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(50);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(50);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails (does not compile)**

Run: `npx vitest run src/services/ledger.test.ts`
Expected: FAIL — TypeScript errors that `balance`/`credit`/`debit` expect a different number of arguments (the old signatures have no `asset`).

- [ ] **Step 3: Rewrite the ledger service with the asset-aware API**

Replace the entire contents of `server/src/services/ledger.ts` with:

```ts
import { eq, and, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

export type Asset = "coin" | "cash";

/** reasons that move real USDC — each MUST carry a non-null ref (idempotency cannot be bypassed) */
const CASH_REASONS = new Set(["deposit", "withdraw_reserve", "withdraw_reverse"]);

function assertPositiveInt(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive integer coin amount, got ${amount}`);
  }
}

function assertRef(reason: string, ref?: string): void {
  if (CASH_REASONS.has(reason) && (ref == null || ref === "")) {
    throw new Error(`reason "${reason}" requires a non-null ref (idempotency)`);
  }
}

export function makeLedger(db: any) {
  /** balance for one asset bucket, using a given query runner (db or an open tx) */
  async function balanceOn(q: any, userId: string, asset: Asset): Promise<number> {
    const rows = await q
      .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.asset, asset)));
    return Number(rows[0]?.bal ?? 0);
  }

  /** per-(user,asset) transaction-scoped advisory lock */
  async function lock(tx: any, userId: string, asset: Asset): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId} || ':' || ${asset}, 0))`);
  }

  /**
   * lock + balance-check + append, within a caller-provided tx.
   * Returns true if it debited, false if a (asset,reason,ref) replay was swallowed.
   */
  async function debitOn(tx: any, userId: string, asset: Asset, amount: number, reason: string, ref?: string): Promise<boolean> {
    assertPositiveInt(amount, "debit amount");
    assertRef(reason, ref);
    await lock(tx, userId, asset);
    const bal = await balanceOn(tx, userId, asset);
    if (bal < amount) throw new Error("insufficient balance");
    const rows = await tx
      .insert(ledgerEntries)
      .values({ userId, asset, delta: -amount, reason, ref: ref ?? null })
      .onConflictDoNothing()
      .returning({ id: ledgerEntries.id });
    return rows.length > 0;
  }

  /** append a credit within a tx (idempotent on (asset,reason,ref)); true if it posted */
  async function creditOn(tx: any, userId: string, asset: Asset, amount: number, reason: string, ref?: string): Promise<boolean> {
    assertPositiveInt(amount, "credit amount");
    assertRef(reason, ref);
    const rows = await tx
      .insert(ledgerEntries)
      .values({ userId, asset, delta: amount, reason, ref: ref ?? null })
      .onConflictDoNothing()
      .returning({ id: ledgerEntries.id });
    return rows.length > 0;
  }

  return {
    async balance(userId: string, asset: Asset): Promise<number> {
      return balanceOn(db, userId, asset);
    },
    balanceOn,
    debitOn,
    creditOn,

    /** low-level append. delta may be + or -. Prefer credit()/debit(). idempotent on (asset,reason,ref). */
    async post(userId: string, asset: Asset, delta: number, reason: string, ref?: string): Promise<boolean> {
      assertRef(reason, ref);
      const rows = await db
        .insert(ledgerEntries)
        .values({ userId, asset, delta, reason, ref: ref ?? null })
        .onConflictDoNothing()
        .returning({ id: ledgerEntries.id });
      return rows.length > 0;
    },

    async credit(userId: string, asset: Asset, amount: number, reason: string, ref?: string): Promise<boolean> {
      assertPositiveInt(amount, "credit amount");
      assertRef(reason, ref);
      const rows = await db
        .insert(ledgerEntries)
        .values({ userId, asset, delta: amount, reason, ref: ref ?? null })
        .onConflictDoNothing()
        .returning({ id: ledgerEntries.id });
      return rows.length > 0;
    },

    async canAfford(userId: string, asset: Asset, amount: number): Promise<boolean> {
      return (await balanceOn(db, userId, asset)) >= amount;
    },

    /** Atomically debit `amount` of `asset`, refusing to overdraw. Returns false on a (reason,ref) replay. */
    async debit(userId: string, asset: Asset, amount: number, reason: string, ref?: string): Promise<boolean> {
      return db.transaction((tx: any) => debitOn(tx, userId, asset, amount, reason, ref));
    },
  };
}

export type Ledger = ReturnType<typeof makeLedger>;
```

- [ ] **Step 4: Update the 6 `routes.ts` call sites to pass `"coin"`**

In `server/src/http/routes.ts`:
- line 48: `deps.ledger.balance(req.userId!)` → `deps.ledger.balance(req.userId!, "coin")`
- line 60: `deps.ledger.credit(userId, deps.startBalance, "signup_faucet", userId)` → `deps.ledger.credit(userId, "coin", deps.startBalance, "signup_faucet", userId)`
- line 63: `deps.ledger.balance(userId)` → `deps.ledger.balance(userId, "coin")`
- line 119: `deps.ledger.balance(req.userId!)` → `deps.ledger.balance(req.userId!, "coin")`
- line 151: `deps.ledger.credit(req.userId!, parsed.data.amount, "dev_grant")` → `deps.ledger.credit(req.userId!, "coin", parsed.data.amount, "dev_grant")`
- line 152: `deps.ledger.balance(req.userId!)` → `deps.ledger.balance(req.userId!, "coin")`

- [ ] **Step 5: Update the 2 `rounds.ts` call sites to pass `"coin"`**

In `server/src/services/rounds.ts`:
- line 55: `await ledger.debitOn(tx, userId, p.stake, "round_stake", roundId);` → `await ledger.debitOn(tx, userId, "coin", p.stake, "round_stake", roundId);`
- line 204: `await ledger.creditOn(tx, userId, result.payoutCoins, "round_payout", roundId);` → `await ledger.creditOn(tx, userId, "coin", result.payoutCoins, "round_payout", roundId);`

- [ ] **Step 6: Find any remaining call sites the compiler flags (incl. tests) and fix them to `"coin"`**

Run: `grep -rnE "\.(credit|creditOn|debit|debitOn|post|canAfford|balance|balanceOn)\(" src --include='*.ts' | grep -vE "services/ledger.ts"`
For every match that is an existing game/faucet/dev flow, insert the asset arg `"coin"` in the same position as Steps 4-5. (All current usage is soft-coin; `"cash"` is introduced only by Plans 2-3.)

- [ ] **Step 7: Typecheck + run the asset test + full suite**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx vitest run`
Expected: PASS — the new `ledger.test.ts` asset-isolation cases pass and every pre-existing server test still passes.

- [ ] **Step 8: Commit**

```bash
git add src/services/ledger.ts src/services/ledger.test.ts src/http/routes.ts src/services/rounds.ts
git commit -m "feat(server): make asset a required ledger param; asset-filtered balance + per-(user,asset) lock; all call sites pass coin"
```

---

### Task 3: Ledger — boolean reserve guard + null-ref enforcement (regression tests)

**Files:**
- Modify: `server/src/services/ledger.test.ts` (append)

> The behavior already exists from Task 2 (boolean returns + `assertRef`). This task locks it with regression tests so a future refactor can't silently reintroduce the double-debit / null-ref bypass.

- [ ] **Step 1: Write the failing regression tests**

Append to `server/src/services/ledger.test.ts` inside the `describe` block:

```ts
  it("a replayed withdraw_reserve debit is swallowed and returns false (no double-debit)", async () => {
    await ctx.ledger.credit(userId, "cash", 1000, "deposit", "fund-1");
    const first = await ctx.ledger.debit(userId, "cash", 300, "withdraw_reserve", "wd-42");
    const second = await ctx.ledger.debit(userId, "cash", 300, "withdraw_reserve", "wd-42");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(700);
  });

  it("a duplicate (asset, reason, ref) credit is a no-op and returns false", async () => {
    expect(await ctx.ledger.credit(userId, "cash", 200, "deposit", "dup-sig")).toBe(true);
    expect(await ctx.ledger.credit(userId, "cash", 200, "deposit", "dup-sig")).toBe(false);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("a cash-moving reason with a null ref throws (idempotency cannot be bypassed)", async () => {
    await expect(ctx.ledger.credit(userId, "cash", 100, "deposit")).rejects.toThrow(/requires a non-null ref/);
    await expect(ctx.ledger.debit(userId, "cash", 100, "withdraw_reserve")).rejects.toThrow(/requires a non-null ref/);
  });
```

- [ ] **Step 2: Run them**

Run: `npx vitest run src/services/ledger.test.ts`
Expected: PASS (behavior was implemented in Task 2).
> If any fail, the Task 2 ledger rewrite is incomplete — fix `ledger.ts` (boolean `returning`, `assertRef`) before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/services/ledger.test.ts
git commit -m "test(server): lock boolean reserve guard + null-ref enforcement for cash reasons"
```

---

### Task 4: Users — set-once `walletPublicKey`

**Files:**
- Modify: `server/src/services/users.ts:1` (imports) and `:24-27` (`setWalletPublicKey`)
- Modify: `server/src/services/users.test.ts` (append)

- [ ] **Step 1: Write the failing set-once test**

Append inside the `describe` block in `server/src/services/users.test.ts`:

```ts
  it("is set-once: a second bind to a DIFFERENT address is ignored", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:xyz");
    await ctx.users.setWalletPublicKey(u.id, "WalletAAA");
    const after = await ctx.users.setWalletPublicKey(u.id, "WalletBBB");
    expect(after.walletPublicKey).toBe("WalletAAA");
    expect((await ctx.users.get(u.id))!.walletPublicKey).toBe("WalletAAA");
  });

  it("is idempotent: re-binding the SAME address is a no-op", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:qqq");
    await ctx.users.setWalletPublicKey(u.id, "WalletSame");
    const again = await ctx.users.setWalletPublicKey(u.id, "WalletSame");
    expect(again.walletPublicKey).toBe("WalletSame");
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/services/users.test.ts`
Expected: FAIL — the "second bind to a different address" test fails because the current unconditional `UPDATE` overwrites to `WalletBBB`.

- [ ] **Step 3: Implement set-once compare-and-set**

In `server/src/services/users.ts`, change the import on line 1 to add `and` and `isNull`:

```ts
import { eq, and, isNull } from "drizzle-orm";
```

Replace `setWalletPublicKey` (lines 24-27) with:

```ts
    /**
     * Bind the user's payout wallet — SET-ONCE. Only writes when currently null.
     * A second bind to a different address is a rebind attempt: ignored + alerted (returns the
     * existing row unchanged). Re-binding the same address is a harmless no-op.
     */
    async setWalletPublicKey(id: string, address: string): Promise<User> {
      const rows = await db
        .update(users)
        .set({ walletPublicKey: address })
        .where(and(eq(users.id, id), isNull(users.walletPublicKey)))
        .returning();
      if (rows[0]) return rows[0];
      const existing = await db.select().from(users).where(eq(users.id, id)).limit(1);
      const cur = existing[0] as User | undefined;
      if (cur && cur.walletPublicKey && cur.walletPublicKey !== address) {
        console.warn(`[wallet_rebind_attempt] user=${id} existing=${cur.walletPublicKey} attempted=${address}`);
      }
      return cur as User;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/users.test.ts`
Expected: PASS (the original "stores and returns" test, plus both new tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/users.ts src/services/users.test.ts
git commit -m "feat(server): make walletPublicKey set-once (rebind attempts ignored + alerted)"
```

---

### Task 5: Privy — deterministic embedded-Solana-wallet picker

**Files:**
- Create: `server/src/auth/privy-wallet.ts`
- Create: `server/src/auth/privy-wallet.test.ts`
- Modify: `server/src/auth/privy.ts:37-43` (`fetchSolanaWallet`)

- [ ] **Step 1: Write the failing picker test**

Create `server/src/auth/privy-wallet.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickEmbeddedSolanaWallet } from "./privy-wallet.js";

const emb = (address: string, first_verified_at?: number) => ({
  type: "wallet", chain_type: "solana", connector_type: "embedded", address, first_verified_at,
});

describe("pickEmbeddedSolanaWallet", () => {
  it("returns null when there is no embedded solana wallet", () => {
    expect(pickEmbeddedSolanaWallet([{ type: "email" } as any])).toBeNull();
    expect(pickEmbeddedSolanaWallet([])).toBeNull();
  });

  it("ignores non-embedded and non-solana wallets", () => {
    const accts = [
      { type: "wallet", chain_type: "ethereum", connector_type: "embedded", address: "0xeth" },
      { type: "wallet", chain_type: "solana", connector_type: "injected", address: "Phantom" },
      emb("EmbSol"),
    ];
    expect(pickEmbeddedSolanaWallet(accts as any)).toBe("EmbSol");
  });

  it("is deterministic across >1 embedded solana wallets (earliest-verified wins) and alerts", () => {
    let alerted = 0;
    const picked = pickEmbeddedSolanaWallet([emb("Bbb", 200), emb("Aaa", 100)] as any, () => { alerted++; });
    expect(picked).toBe("Aaa");
    expect(alerted).toBe(1);
  });

  it("falls back to address order when timestamps are equal/absent", () => {
    expect(pickEmbeddedSolanaWallet([emb("Zzz"), emb("Aaa")] as any)).toBe("Aaa");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/auth/privy-wallet.test.ts`
Expected: FAIL — `Cannot find module './privy-wallet.js'`.

- [ ] **Step 3: Implement the pure picker**

Create `server/src/auth/privy-wallet.ts`:

```ts
export interface LinkedAccount {
  type?: string;
  chain_type?: string;
  connector_type?: string;
  address?: string;
  first_verified_at?: number | null;
}

/**
 * Deterministically select the user's embedded Solana wallet address.
 * Earliest-verified wins; ties (or missing timestamps) break by address order.
 * Returns null if the user has no embedded Solana wallet. Calls `onMultiple` if >1 exist
 * (a non-deterministic source we want to know about — see spec §4).
 */
export function pickEmbeddedSolanaWallet(
  linkedAccounts: LinkedAccount[],
  onMultiple?: (count: number) => void,
): string | null {
  const wallets = (linkedAccounts ?? []).filter(
    (a) => a.type === "wallet" && a.chain_type === "solana" && a.connector_type === "embedded" && !!a.address,
  );
  if (wallets.length === 0) return null;
  if (wallets.length > 1) onMultiple?.(wallets.length);
  wallets.sort((a, b) => {
    const ta = a.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    const tb = b.first_verified_at ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return (a.address as string).localeCompare(b.address as string);
  });
  return wallets[0].address as string;
}
```

- [ ] **Step 4: Run the picker tests to verify they pass**

Run: `npx vitest run src/auth/privy-wallet.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Delegate `fetchSolanaWallet` to the picker**

In `server/src/auth/privy.ts`, add the import after line 1:

```ts
import { pickEmbeddedSolanaWallet } from "./privy-wallet.js";
```

Replace `fetchSolanaWallet` (lines 37-43) with:

```ts
    async fetchSolanaWallet(did) {
      const user = await privy.users()._get(did); // underscore: Stainless reserves get()
      return pickEmbeddedSolanaWallet(user.linked_accounts as any, (n) =>
        console.warn(`[multiple_embedded_solana_wallets] did=${did} count=${n}`),
      );
    },
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/privy-wallet.ts src/auth/privy-wallet.test.ts src/auth/privy.ts
git commit -m "feat(server): deterministic embedded-solana-wallet picker (earliest-verified, alert on >1)"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole server**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run the full server test suite**

Run: `npx vitest run`
Expected: all suites PASS (the pre-existing tests + the new `ledger.test.ts`, `privy-wallet.test.ts`, and extended `users.test.ts`).

- [ ] **Step 3: Confirm the seam holds end-to-end**

Run: `grep -rnE "ledger\.(credit|debit|post)\(" src --include='*.ts' | grep -v "\.test\.ts"`
Expected: every call passes an explicit asset (`"coin"` for all current flows). No bare 4-arg `credit`/`debit` remains.

- [ ] **Step 4: Verify the branch state**

Run: `git log --oneline -6`
Expected: the five feature/test commits from Tasks 1-5 on top of the spec commits.

---

## Self-review

- **Spec coverage (§3, §3a, §4):** asset enum+column (T1), required asset param + compile-forced call sites (T2), asset-filtered balance + per-`(user,asset)` lock (T2), asset-aware idempotency index + null-ref CHECK + in-code `assertRef` (T1/T2/T3), boolean `debitOn`/`creditOn` reserve guard (T2/T3), set-once `walletPublicKey` (T4), deterministic embedded-wallet picker (T5). The `deposit_sources` table and the new `deposits`/`withdrawals` tables are intentionally **deferred to Plans 2/3** (no consumer exists yet). `L = SUM(delta WHERE asset='cash')` is enabled by T1/T2; the reconciliation that reads it lives in Plan 2.
- **Placeholders:** none — every code/test step shows complete content; the one conditional (Step 1.5 fallback SQL) is fully specified.
- **Type consistency:** the asset arg position is `(…, userId, asset, …)` for `balanceOn`/`debitOn`/`creditOn` and `(userId, asset, …)` for `balance`/`credit`/`debit`/`post`/`canAfford`, applied identically at every call site. `Asset = "coin" | "cash"` is the single type. `pickEmbeddedSolanaWallet` signature matches its test and its `privy.ts` caller.
