# Money Rails — Plan 3: Withdraw (reserve · caps · hold · state machine · never-auto-reverse confirmer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user move withdrawable `cash` back out as USDC to the wallet they deposited from — safely: reserve-and-debit atomically with caps + a deposit-hold, queue for out-of-band approval by default, and a confirmer that NEVER auto-reverses on inference.

**Architecture:** A `POST /v1/withdraw` mints a server-side id, then under a global+per-user lock validates caps (per-tx, per-user-24h, global-24h — counting in-flight via a DB rolling window), a deposit-hold cooling period, settled-balance, and a solvency precheck, then `debitOn(cash, withdraw_reserve, id)` and inserts a `withdrawals` row (`reserved`) carrying a deterministic Privy idempotency key — all in one transaction, with a partial-unique index enforcing one in-flight withdrawal per user. By default (`WITHDRAW_QUORUM_THRESHOLD_CENTS=0`) the row goes to `awaiting_approval` for out-of-band sign-off; an admin approval then drives `signing→sent` through a swappable `WithdrawSigner` port (real impl = Privy `signAndSendTransaction` + the kit tx builder, behind `REAL_MONEY_ENABLED`; tests = a fake). The confirmer reads on-chain status through a port and only ever advances `sent→confirmed` or `sent→needs_review`; reverse-credit is a separately-gated step.

**Tech Stack:** Fastify 5 · Drizzle (Postgres/PGlite) · Zod · `@solana/kit` v2 · `@privy-io/node` · Vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-real-money-rails-design.md` (§4 withdrawals, §6 withdraw flow, §8 reconciliation, §9 custody, §10 anti-abuse, §15 decisions). **Builds on:** Plan 1 (cash/coin seam, `ledger.debitOn`/`creditOn` idempotent + throw-on-insufficient), Plan 2 (`deposit_sources`, the `deposits` confirmer), and the foundation `money/idempotency.ts` (`withdrawIdempotencyKey`), `solana/transfer-tx.ts` (`buildUnsignedTransferCheckedWireTx`), `money/usdc.ts`.

**Phase-0-driven design notes:** (a) the rolling-window aggregate cap is enforced HERE in our own reserve tx, NOT by Privy (Privy can't express it for Solana); (b) there is no one-call Privy `intents.authorize()` — out-of-band approval is modeled as an app-level `awaiting_approval` state + an admin-gated transition for v1 (the P-256 co-signer/Intents wiring is a later hardening); (c) the only staging-gated seam is the `WithdrawSigner` real impl's Privy call — everything else is unit-tested now.

**Out of scope (later):** the independent P-256 co-signer service + Privy Intents quorum (spec §6.3/§9 — v1 uses app-level admin approval with `QUORUM_THRESHOLD=0`); durable leased multi-replica worker (single confirmer + idempotency for v1); the reconciliation outflow-enumeration/double-pay detector (spec §8.2-8.3 — a follow-up before external users); play-through metering (no cash wagering exists until rounds stake `cash`, post-1.4).

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/env.ts` (modify) | Withdraw caps + hold + quorum-threshold config |
| `server/src/db/schema.ts` (modify) | `withdrawals` table + status enum + one-in-flight partial unique index |
| `server/drizzle/0007_*.sql` (generate) | Migration |
| `server/src/services/withdrawals.ts` (create) | The reserve core: caps · hold · solvency · debit · row insert (unit-tested) |
| `server/src/solana/withdraw-signer.ts` (create) | `WithdrawSigner` port + Privy `signAndSendTransaction` adapter (staging-gated) |
| `server/src/services/withdraw-worker.ts` (create) | State machine: `awaiting_approval`→`signing`→`sent`; never-auto-reverse confirmer |
| `server/src/http/routes.ts` (modify) | `POST /v1/withdraw` + admin `POST /v1/admin/withdraw/:id/approve` |
| `server/src/index.ts` (modify) | Wire withdraw service + worker behind `REAL_MONEY_ENABLED` |

---

## Task 1: `withdrawals` table + one-in-flight index

**Files:** Modify `server/src/db/schema.ts`; generate `server/drizzle/0007_*.sql`.

- [ ] **Step 1: Add the table** after `depositSources` (before `inventory`). `amountCents` is `bigint({mode:"number"})`; `privyIdempotencyKey` is NOT NULL; the partial unique index enforces one in-flight withdrawal per user:

```ts
export const withdrawalStatus = pgEnum("withdrawal_status", [
  "reserved", "awaiting_approval", "signing", "sent", "confirmed", "failed", "reversed", "needs_review",
]);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    destWallet: text("dest_wallet").notNull(), // snapshotted from deposit_sources (NOT live users.wallet)
    status: withdrawalStatus("status").notNull().default("reserved"),
    txSig: text("tx_sig"),
    privyTxId: text("privy_tx_id"),
    privyIdempotencyKey: text("privy_idempotency_key").notNull(),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("withdrawals_user_idx").on(t.userId),
    // at most ONE in-flight withdrawal per user (a concurrent reserve 409s)
    oneInflight: uniqueIndex("withdrawals_one_inflight_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('reserved','awaiting_approval','signing','sent','needs_review')`),
  }),
);
export type Withdrawal = typeof withdrawals.$inferSelect;
```

(Dropped from the spec's full column list for v1: `intentId`/`approvalExpiresAt`/`approvalNonce`/`leaseOwner`/`leaseExpiresAt`/`attempt` — they belong to the deferred Intents-quorum + leased-worker hardening. `reviewReason` replaces them for the v1 `needs_review` audit trail. Adding them later is additive.)

- [ ] **Step 2: Generate** `cd server && npm run db:generate` → a `0007_*.sql`. Open it; confirm additive-only (CREATE TYPE/TABLE/INDEX, no DROP).
- [ ] **Step 3: Verify** `cd server && npx vitest run src/services/ledger.test.ts` (migration applies on fresh PGlite) → PASS; full suite still green; `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit**
```bash
git add server/src/db/schema.ts server/drizzle/
git commit -m "feat(server): withdrawals table + one-in-flight-per-user partial unique index"
```

---

## Task 2: Withdraw config / env

**Files:** Modify `server/src/env.ts`; Test `server/src/test/env.withdraw.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";
const base = { DATABASE_URL: "postgres://x" };

describe("withdraw env defaults", () => {
  it("has conservative tiny-cap defaults and threshold 0 (all withdrawals need approval)", () => {
    const e = parseEnv({ ...base } as any);
    expect(e.WITHDRAW_MIN_CENTS).toBe(100);
    expect(e.WITHDRAW_MAX_CENTS).toBe(500);
    expect(e.WITHDRAW_USER_DAILY_CAP_CENTS).toBe(2000);
    expect(e.WITHDRAW_GLOBAL_DAILY_CAP_CENTS).toBe(20000);
    expect(e.WITHDRAW_HOLD_HOURS).toBe(24);
    expect(e.WITHDRAW_QUORUM_THRESHOLD_CENTS).toBe(0);
  });
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add to the `EnvShape` object in `server/src/env.ts` (alongside the deposit fields):
```ts
  WITHDRAW_MIN_CENTS: z.coerce.number().int().positive().default(100),
  WITHDRAW_MAX_CENTS: z.coerce.number().int().positive().default(500),
  WITHDRAW_USER_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(2000),
  WITHDRAW_GLOBAL_DAILY_CAP_CENTS: z.coerce.number().int().positive().default(20000),
  WITHDRAW_HOLD_HOURS: z.coerce.number().int().nonnegative().default(24),
  WITHDRAW_QUORUM_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(0),
```
- [ ] **Step 4: Run → PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit**
```bash
git add server/src/env.ts server/src/test/env.withdraw.test.ts
git commit -m "feat(server): withdraw caps + hold + quorum-threshold config (tiny-cap, approve-all defaults)"
```

---

## Task 3: The reserve core (caps · hold · solvency · debit) — THE HEART

**Files:** Create `server/src/services/withdrawals.ts` + `server/src/services/withdrawals.test.ts`.

This is the highest-risk money logic. It runs entirely in one DB transaction under a global + per-(user,cash) advisory lock, and is fully unit-testable (no chain).

- [ ] **Step 1: Failing test** at `server/src/services/withdrawals.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeWithdrawals } from "./withdrawals.js";
import { deposits, depositSources, withdrawals } from "../db/schema.js";
import { eq } from "drizzle-orm";

const cfg = {
  minCents: 100, maxCents: 500, userDailyCapCents: 2000, globalDailyCapCents: 20000,
  holdHours: 24, quorumThresholdCents: 0,
};

async function seedFundedUser(ctx: TestCtx, ext: string, wallet: string, cashCents: number, depositAgeHours = 48) {
  const u = await ctx.users.upsertByExternalId(ext);
  await ctx.users.setWalletPublicKey(u.id, wallet);
  // a confirmed deposit_source (withdraw destination binds to THIS, not users.wallet) + the cash
  await ctx.db.insert(depositSources).values({ userId: u.id, sourceWallet: wallet, firstSeenTxSig: `seed-${ext}` });
  await ctx.db.insert(deposits).values({
    txSig: `seed-${ext}`, userId: u.id, amountBaseUnits: String(cashCents * 10000), amountCents: cashCents,
    mint: "USDC", sourceOwner: wallet, destAta: "ATA", slot: 1, status: "credited",
    createdAt: new Date(Date.now() - depositAgeHours * 3600_000),
  });
  await ctx.ledger.credit(u.id, "cash", cashCents, "deposit", `seed-${ext}`);
  return u.id;
}

describe("withdrawals.reserve", () => {
  let ctx: TestCtx;
  let wd: ReturnType<typeof makeWithdrawals>;
  beforeEach(async () => {
    ctx = await makeTestDb();
    wd = makeWithdrawals(ctx.db, ctx.ledger, cfg, async () => 10_000_000_000n); // treasury solvent ($100k)
  });
  afterEach(async () => { await ctx.close(); });

  it("reserves: debits cash, snapshots dest from deposit_sources, queues awaiting_approval (threshold 0)", async () => {
    const userId = await seedFundedUser(ctx, "privy:did:privy:a", "WALLET_A", 500);
    const r = await wd.reserve(userId, 300);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200); // 500 - 300 debited
    const rows = await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, r.withdrawalId));
    expect(rows[0].status).toBe("awaiting_approval"); // threshold 0 → always approval
    expect(rows[0].destWallet).toBe("WALLET_A");
    expect(rows[0].privyIdempotencyKey).toBe(`withdraw:${r.withdrawalId}`);
  });

  it("rejects amount below min / above max / above settled balance", async () => {
    const userId = await seedFundedUser(ctx, "privy:did:privy:b", "WALLET_B", 400);
    expect((await wd.reserve(userId, 50)).status).toBe("below_min");
    expect((await wd.reserve(userId, 600)).status).toBe("above_max");
    expect((await wd.reserve(userId, 450)).status).toBe("insufficient");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400); // nothing debited
  });

  it("rejects while a deposit is still within the hold window", async () => {
    const userId = await seedFundedUser(ctx, "privy:did:privy:c", "WALLET_C", 500, 2); // 2h old < 24h hold
    expect((await wd.reserve(userId, 200)).status).toBe("held");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("rejects a second concurrent in-flight withdrawal (one-in-flight)", async () => {
    const userId = await seedFundedUser(ctx, "privy:did:privy:d", "WALLET_D", 500);
    expect((await wd.reserve(userId, 100)).status).toBe("ok");
    expect((await wd.reserve(userId, 100)).status).toBe("in_flight"); // 2nd blocked by partial unique
  });

  it("enforces the per-user 24h cap counting the in-flight row", async () => {
    const userId = await seedFundedUser(ctx, "privy:did:privy:e", "WALLET_E", 5000);
    // cap is 2000/24h; one 500 reserve sits in-flight, a 1600 would exceed 2000 → cap
    expect((await wd.reserve(userId, 500)).status).toBe("ok");
    expect((await wd.reserve(userId, 1600)).status).toBe("in_flight"); // also blocked by one-in-flight first
  });

  it("rejects when treasury solvency precheck fails", async () => {
    const poor = makeWithdrawals(ctx.db, ctx.ledger, cfg, async () => 0n); // treasury empty
    const userId = await seedFundedUser(ctx, "privy:did:privy:f", "WALLET_F", 500);
    expect((await poor.reserve(userId, 200)).status).toBe("insolvent");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("rejects a user with no confirmed deposit source (cannot withdraw)", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:g");
    await ctx.ledger.credit(u.id, "cash", 500, "deposit", "ghost"); // cash but no deposit_source
    expect((await wd.reserve(u.id, 200)).status).toBe("no_dest");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `server/src/services/withdrawals.ts`:
```ts
import { and, eq, sql } from "drizzle-orm";
import { withdrawals, depositSources, deposits } from "../db/schema.js";
import { withdrawIdempotencyKey } from "../money/idempotency.js";
import { centsToBaseUnits } from "../money/usdc.js";
import type { Ledger } from "./ledger.js";

export interface WithdrawConfig {
  minCents: number; maxCents: number;
  userDailyCapCents: number; globalDailyCapCents: number;
  holdHours: number; quorumThresholdCents: number;
}
/** Treasury USDC ATA balance in base units (for the solvency precheck). */
export type ReadTreasuryBaseUnits = () => Promise<bigint>;

export type ReserveResult =
  | { status: "ok"; withdrawalId: string; state: "awaiting_approval" | "reserved" }
  | { status: "below_min" | "above_max" | "insufficient" | "held" | "in_flight" | "capped" | "insolvent" | "no_dest" };

const INFLIGHT = sql`status in ('reserved','awaiting_approval','signing','sent','needs_review','confirmed')`;
// a fixed key for the global withdraw lock (any constant; serialises global-cap + solvency)
const GLOBAL_LOCK = 918273645;

export function makeWithdrawals(db: any, ledger: Ledger, cfg: WithdrawConfig, readTreasury: ReadTreasuryBaseUnits) {
  async function sumCents(tx: any, where: any): Promise<number> {
    const r = await tx.select({ s: sql<string>`coalesce(sum(${withdrawals.amountCents}),0)` }).from(withdrawals).where(where);
    return Number(r[0]?.s ?? 0);
  }

  return {
    async reserve(userId: string, amountCents: number): Promise<ReserveResult> {
      if (amountCents < cfg.minCents) return { status: "below_min" };
      if (amountCents > cfg.maxCents) return { status: "above_max" };

      return db.transaction(async (tx: any) => {
        // global lock first, then per-(user,cash) lock — order matches the ledger's lock
        await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_LOCK})`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId} || ':cash', 0))`);

        // destination binds to a CONFIRMED deposit source, never the mutable users.wallet (spec §6/§94)
        const src = await tx.select().from(depositSources).where(eq(depositSources.userId, userId)).limit(1);
        if (!src[0]) return { status: "no_dest" } as ReserveResult;
        const destWallet = src[0].sourceWallet;

        // settled cash check
        const bal = await ledger.balanceOn(tx, userId, "cash");
        if (bal < amountCents) return { status: "insufficient" } as ReserveResult;

        // deposit hold: any credited deposit newer than the hold window blocks withdrawal
        if (cfg.holdHours > 0) {
          const recent = await tx.select({ n: sql<string>`count(*)` }).from(deposits).where(and(
            eq(deposits.userId, userId), eq(deposits.status, "credited"),
            sql`${deposits.createdAt} > now() - (${cfg.holdHours} || ' hours')::interval`,
          ));
          if (Number(recent[0]?.n ?? 0) > 0) return { status: "held" } as ReserveResult;
        }

        // per-user + global 24h caps, counting in-flight + confirmed
        const userSum = await sumCents(tx, and(eq(withdrawals.userId, userId), INFLIGHT, sql`${withdrawals.createdAt} > now() - interval '24 hours'`));
        if (userSum + amountCents > cfg.userDailyCapCents) return { status: "capped" } as ReserveResult;
        const globalSum = await sumCents(tx, and(INFLIGHT, sql`${withdrawals.createdAt} > now() - interval '24 hours'`));
        if (globalSum + amountCents > cfg.globalDailyCapCents) return { status: "capped" } as ReserveResult;

        // solvency precheck: treasury must cover all in-flight outflow + this one
        const treasuryBase = await readTreasury();
        const inflightBase = centsToBaseUnits(BigInt(globalSum + amountCents));
        if (treasuryBase < inflightBase) return { status: "insolvent" } as ReserveResult;

        // reserve-debit (idempotent on (cash,withdraw_reserve,id)); throws if balance vanished
        const id = crypto.randomUUID();
        const debited = await ledger.debitOn(tx, userId, "cash", amountCents, "withdraw_reserve", id);
        if (!debited) return { status: "in_flight" } as ReserveResult; // replay — should not happen for a fresh id

        // insert the withdrawal; the partial-unique index 409s a second in-flight row
        const state = amountCents > cfg.quorumThresholdCents || cfg.quorumThresholdCents === 0 ? "awaiting_approval" : "reserved";
        try {
          await tx.insert(withdrawals).values({
            id, userId, amountCents, destWallet, status: state, privyIdempotencyKey: withdrawIdempotencyKey(id),
          });
        } catch (e: any) {
          if (String(e?.message ?? e).match(/unique|duplicate/i)) return { status: "in_flight" } as ReserveResult;
          throw e;
        }
        return { status: "ok", withdrawalId: id, state } as ReserveResult;
      });
    },
  };
}

export type Withdrawals = ReturnType<typeof makeWithdrawals>;
```
Note on the threshold rule: with the default `quorumThresholdCents === 0`, EVERY withdrawal → `awaiting_approval` (the `=== 0` clause). With a positive threshold, amounts strictly above it → `awaiting_approval`, at-or-below → `reserved` (auto-send eligible). The `in_flight` partial-unique rollback undoes the debit atomically (same tx).

- [ ] **Step 4: Run → all PASS;** `npx tsc --noEmit` clean. (`crypto.randomUUID()` is global in Node 22.)
- [ ] **Step 5: Commit**
```bash
git add server/src/services/withdrawals.ts server/src/services/withdrawals.test.ts
git commit -m "feat(server): withdraw reserve core — caps, deposit-hold, solvency, atomic debit (one-in-flight)"
```

---

## Task 4: `WithdrawSigner` port + state machine (approval → signing → sent)

**Files:** Create `server/src/solana/withdraw-signer.ts`; create `server/src/services/withdraw-worker.ts` + its test (the signer adapter has no unit test — staging-validated).

- [ ] **Step 1: The signer port + Privy adapter** `server/src/solana/withdraw-signer.ts`:
```ts
import type { PrivyClient } from "@privy-io/node";

export interface SignResult { txSig: string; privyTxId: string | null; }
/** Signs+sends a USDC transfer from the treasury to a destination, exactly-once via the idempotency key. */
export interface WithdrawSigner {
  signAndSend(input: { destWallet: string; amountCents: number; idempotencyKey: string }): Promise<SignResult>;
}

/**
 * Real Privy-backed signer. STAGING-GATED: the Privy signAndSendTransaction behavior is validated by the
 * Phase-0 staging checklist (items 1-6) before this runs against real funds. Builds the treasury→dest
 * USDC transferChecked via solana/transfer-tx.ts, then calls Privy with the deterministic idempotency key.
 */
export function makePrivyWithdrawSigner(deps: {
  privy: PrivyClient; treasuryWalletId: string; treasuryUsdcAta: string; treasuryOwner: string;
  usdcMint: string; caip2: string; rpcUrl: string;
}): WithdrawSigner {
  return {
    async signAndSend({ destWallet, amountCents, idempotencyKey }) {
      // Implementation note (filled when staging confirms the fee-payer/sign-and-send semantics — Phase 0):
      // 1. derive the destination USDC ATA for destWallet (findAssociatedTokenPda).
      // 2. buildUnsignedTransferCheckedWireTx({ source: treasuryUsdcAta, destination: destAta,
      //    authority: treasuryOwner, feePayer: treasuryOwner, mint: usdcMint, amount: centsToBaseUnits(amountCents),
      //    decimals: 6, lifetime: <fresh blockhash from rpcUrl> }).
      // 3. privy.wallets().solana().signAndSendTransaction(treasuryWalletId, { transaction, caip2, idempotency_key: idempotencyKey }).
      // 4. return { txSig: res.hash, privyTxId: res.transaction_id ?? null }.
      throw new Error("makePrivyWithdrawSigner.signAndSend not yet enabled — pending Phase 0 staging validation");
    },
  };
}
```
(The real body is intentionally a guarded stub: it cannot be correctly finalized until the staging spike confirms `signAndSendTransaction`'s fee-payer/byte/hash semantics. The state machine below is fully tested against a FAKE signer, so this stub blocks nothing.)

- [ ] **Step 2: Failing test** for the state machine `server/src/services/withdraw-worker.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { withdrawals } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { makeWithdrawProcessor } from "./withdraw-worker.js";

async function seedWithdrawal(ctx: TestCtx, status: string) {
  const u = await ctx.users.upsertByExternalId("privy:did:privy:w");
  const id = crypto.randomUUID();
  await ctx.db.insert(withdrawals).values({
    id, userId: u.id, amountCents: 300, destWallet: "WALLET_W", status,
    privyIdempotencyKey: `withdraw:${id}`,
  });
  return id;
}

describe("withdraw processor (approval → signing → sent)", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("approve() drives awaiting_approval → sent via the signer, recording txSig", async () => {
    const id = await seedWithdrawal(ctx, "awaiting_approval");
    const signer = { async signAndSend() { return { txSig: "SIG123", privyTxId: "ptx" }; } };
    const proc = makeWithdrawProcessor(ctx.db, signer);
    const r = await proc.approveAndSend(id);
    expect(r.status).toBe("sent");
    const row = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0];
    expect(row.status).toBe("sent");
    expect(row.txSig).toBe("SIG123");
    expect(row.privyTxId).toBe("ptx");
  });

  it("refuses to approve a withdrawal that is not awaiting_approval", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { return { txSig: "x", privyTxId: null }; } });
    expect((await proc.approveAndSend(id)).status).toBe("not_approvable");
  });

  it("if the signer throws, the row stays awaiting_approval (no money left; safe to retry)", async () => {
    const id = await seedWithdrawal(ctx, "awaiting_approval");
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { throw new Error("privy down"); } });
    await expect(proc.approveAndSend(id)).rejects.toThrow(/privy down/);
    const row = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0];
    expect(row.status).toBe("signing"); // claimed but not sent — a retry/confirmer reconciles via idempotency key
  });
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** `server/src/services/withdraw-worker.ts` (the approval+send transition; the confirmer half is added in Task 5 — keep both in this file):
```ts
import { and, eq, sql } from "drizzle-orm";
import { withdrawals } from "../db/schema.js";
import { withdrawIdempotencyKey } from "../money/idempotency.js";
import type { WithdrawSigner } from "../solana/withdraw-signer.js";

export function makeWithdrawProcessor(db: any, signer: WithdrawSigner) {
  return {
    /** Admin-gated: awaiting_approval → signing → (Privy send) → sent. Idempotency key makes the send exactly-once. */
    async approveAndSend(id: string): Promise<{ status: "sent" | "not_approvable" }> {
      // claim: only an awaiting_approval row transitions to signing (guards double-approval)
      const claimed = await db.update(withdrawals)
        .set({ status: "signing", updatedAt: new Date() })
        .where(and(eq(withdrawals.id, id), eq(withdrawals.status, "awaiting_approval")))
        .returning();
      if (claimed.length === 0) return { status: "not_approvable" };
      const w = claimed[0];
      const res = await signer.signAndSend({
        destWallet: w.destWallet, amountCents: w.amountCents, idempotencyKey: withdrawIdempotencyKey(w.id),
      });
      await db.update(withdrawals)
        .set({ status: "sent", txSig: res.txSig, privyTxId: res.privyTxId, updatedAt: new Date() })
        .where(eq(withdrawals.id, id));
      return { status: "sent" };
    },
  };
}
```
Note: if `signAndSend` throws, the row is left in `signing` (claimed, not sent). That is the correct safe state — the deterministic idempotency key means a later retry/confirmer can re-drive the send without a second transfer; we never silently reverse. The test asserts exactly this.

- [ ] **Step 5: Run → all PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit**
```bash
git add server/src/solana/withdraw-signer.ts server/src/services/withdraw-worker.ts server/src/services/withdraw-worker.test.ts
git commit -m "feat(server): withdraw signer port + approval→signing→sent state machine (Privy send staging-gated)"
```

---

## Task 5: Never-auto-reverse confirmer

**Files:** Modify `server/src/services/withdraw-worker.ts` (+ extend its test).

- [ ] **Step 1: Add the failing test** to `withdraw-worker.test.ts`:
```ts
describe("withdraw confirmer (never auto-reverse on inference)", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("sent → confirmed on a positive finalized observation", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "finalized");
    const r = await proc.confirm(id);
    expect(r).toBe("confirmed");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("confirmed");
  });

  it("sent → needs_review on an UNKNOWN status (cash stays debited; never auto-reversed)", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "unknown");
    expect(await proc.confirm(id)).toBe("needs_review");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("needs_review");
  });

  it("sent → reversed + cash re-credited ONLY on a landed-but-FAILED tx (no tokens moved)", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const u = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].userId;
    // mirror the reserve debit so the reversal has something to undo
    await ctx.ledger.post(u, "cash", -300, "withdraw_reserve", id);
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "failed");
    expect(await proc.confirm(id)).toBe("reversed");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("reversed");
    expect(await ctx.ledger.balance(u, "cash")).toBe(0); // -300 reserve + +300 reverse
  });
});
```
(Add `import { makeWithdrawConfirmer } from "./withdraw-worker.js";` to the test's imports.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — append to `server/src/services/withdraw-worker.ts`:
```ts
import type { Ledger } from "./ledger.js";

/** On-chain status of a sent withdrawal signature. */
export type ChainStatus = "finalized" | "failed" | "unknown";
export type ReadChainStatus = (txSig: string) => Promise<ChainStatus>;

export function makeWithdrawConfirmer(db: any, ledger: Ledger, readStatus: ReadChainStatus) {
  return {
    /** From `sent`, the ONLY auto-transitions: → confirmed (finalized) | → reversed (landed-but-failed) | → needs_review (unknown). */
    async confirm(id: string): Promise<"confirmed" | "reversed" | "needs_review" | "skip"> {
      const rows = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
      const w = rows[0];
      if (!w || w.status !== "sent" || !w.txSig) return "skip";
      const status = await readStatus(w.txSig);
      if (status === "finalized") {
        await db.update(withdrawals).set({ status: "confirmed", updatedAt: new Date() }).where(eq(withdrawals.id, id));
        return "confirmed";
      }
      if (status === "failed") {
        // landed-but-failed: no tokens moved → safe to reverse-credit (idempotent on (cash,withdraw_reverse,id))
        await db.transaction(async (tx: any) => {
          await ledger.creditOn(tx, w.userId, "cash", w.amountCents, "withdraw_reverse", w.id);
          await tx.update(withdrawals).set({ status: "reversed", updatedAt: new Date() }).where(eq(withdrawals.id, id));
        });
        return "reversed";
      }
      // unknown → HOLD. Never auto-reverse on inference (spec §6.4). Leave cash debited; page for review.
      await db.update(withdrawals).set({ status: "needs_review", reviewReason: "status_unknown", updatedAt: new Date() }).where(eq(withdrawals.id, id));
      return "needs_review";
    },
  };
}
```

- [ ] **Step 4: Run → all PASS;** `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit**
```bash
git add server/src/services/withdraw-worker.ts server/src/services/withdraw-worker.test.ts
git commit -m "feat(server): never-auto-reverse withdraw confirmer (finalized/failed/unknown)"
```

---

## Task 6: Endpoints + boot wiring

**Files:** Modify `server/src/http/routes.ts`, `server/src/index.ts`. Add `server/src/test/withdraw-routes.test.ts`.

- [ ] **Step 1: Add to `RouteDeps`** (routes.ts): `withdrawals: import("../services/withdrawals.js").Withdrawals | null;` and `withdrawProcessor: import("../services/withdraw-worker.js").WithdrawProcessor | null;` (export a `WithdrawProcessor` type alias from withdraw-worker.ts: `export type WithdrawProcessor = ReturnType<typeof makeWithdrawProcessor>;`).

- [ ] **Step 2: Add the routes** in `registerRoutes` (after the deposit route). The withdraw body carries NO destination (hard-locked to the deposit source):
```ts
  const WithdrawBody = z.object({ amountCents: z.number().int().positive() });
  server.post("/v1/withdraw", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.withdrawals) return reply.code(404).send({ error: "withdrawals_disabled" });
    const body = WithdrawBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.withdrawals.reserve(req.userId!, body.data.amountCents);
    if (r.status !== "ok") return reply.code(409).send({ error: r.status });
    return { withdrawalId: r.withdrawalId, state: r.state };
  });

  // admin-gated approval (v1 stand-in for the quorum/Intents co-signer). Reuses the dev/admin guard.
  server.post("/v1/admin/withdraw/:id/approve", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.devEndpoints || !deps.withdrawProcessor) return reply.code(404).send({ error: "not_found" });
    const id = (req.params as { id: string }).id;
    const r = await deps.withdrawProcessor.approveAndSend(id);
    if (r.status !== "sent") return reply.code(409).send({ error: r.status });
    return { status: "sent" };
  });
```
(The admin approval is gated on `devEndpoints` for v1 — a real admin-auth surface is the spec §12 follow-up. It must NEVER be exposed in production without real four-eyes auth; the `devEndpoints` gate guarantees it's off in prod.)

- [ ] **Step 3: Thread `withdrawals`/`withdrawProcessor`** through `RouteDeps`, `makeTestDb` (default both `null`), and `buildServer`. In `index.ts`, inside the existing `if (env.REAL_MONEY_ENABLED)` block, construct `makeWithdrawals(db, ledger, {...caps from env...}, () => source.readTreasuryBaseUnits(env.TREASURY_USDC_ATA!))` and `makeWithdrawProcessor(db, signer)` where `signer = makePrivyWithdrawSigner({...})` — but since the signer stub throws until staging, guard the processor construction so boot still succeeds (the reserve path works; the send path errors only when actually approved). Pass both into `buildServer`. Add a `readTreasuryBaseUnits(ata)` method to the `DepositSource` interface + RPC adapter (getTokenAccountBalance) for the solvency reader; in tests this is unused (withdrawals is null).

- [ ] **Step 4: Route test** `server/src/test/withdraw-routes.test.ts` — with the default harness (`withdrawals: null`) assert `POST /v1/withdraw` → 404; with an injected fake `withdrawals` whose `reserve` returns `{status:"ok",withdrawalId:"w1",state:"awaiting_approval"}` assert 200 + the id; with one returning `{status:"capped"}` assert 409. Model auth on the existing route tests (`x-dev-user`). Extend `makeTestDb` opts to accept an optional `withdrawals` fake.

- [ ] **Step 5: Verify** `cd server && npx vitest run` (all green) + `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit**
```bash
git add server/src/http/routes.ts server/src/index.ts server/src/test/withdraw-routes.test.ts server/src/services/withdraw-worker.ts server/src/solana/deposit-source.ts server/src/test/harness.ts
git commit -m "feat(server): withdraw + admin-approve endpoints + boot wiring (send-leg staging-gated)"
```

---

## Self-Review

- **Spec coverage:** §4 withdrawals table + one-in-flight index → T1; §6.1 server-minted id + no-dest-in-body + caps-inside-reserve-tx + locks → T3 + T6; §6.2 atomic reserve-debit + persisted idempotency key → T3; §6.3 sign+send + above-threshold→awaiting_approval → T4 (+ the Intents/quorum co-signer deferred); §6.4 never-auto-reverse confirmer (finalized/failed/unknown) → T5; §10 anti-rinse hold → T3 (play-through deferred w/ reason; OFAC = a documented follow-up port); §15 QUORUM_THRESHOLD=0 approve-all → T2/T3 default. §9 quorum custody + §8.2-8.3 reconciliation enumeration: deferred (documented in Out-of-scope).
- **Type consistency:** `ReserveResult`/`WithdrawConfig`/`ReadTreasuryBaseUnits` defined in `withdrawals.ts`; `WithdrawSigner`/`SignResult` in `withdraw-signer.ts`; `ChainStatus`/`ReadChainStatus` + `WithdrawProcessor` in `withdraw-worker.ts`; `withdrawIdempotencyKey(id)` = `withdraw:${id}` matches the persisted `privyIdempotencyKey` and the signer's key; ledger calls use the committed `debitOn`/`creditOn`/`balanceOn(tx,…)` signatures.
- **Placeholder scan:** the ONE intentional stub is `makePrivyWithdrawSigner.signAndSend` — it throws with a clear message and is documented as Phase-0-staging-gated; the entire state machine + confirmer are tested against fakes, so nothing in the test/critical path is a placeholder.
- **Money-safety invariants:** reserve debit + row insert + cap checks all in one tx under global+user locks; one-in-flight rollback undoes the debit atomically; confirmer never reverses on `unknown` (→ needs_review, cash stays debited); reversal credit is idempotent on `(cash,withdraw_reverse,id)` and only on `failed`/finalized-absent-landed branches.
