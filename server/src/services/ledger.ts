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

  /**
   * Raw signed append within a caller-provided tx. `delta` may be + or - and is NOT
   * balance-checked — the balance is allowed to go negative (used for the house counterparty,
   * whose bankroll legitimately runs red when under-capitalized). No advisory lock is taken:
   * a pure append has no read-modify-write to serialize. Idempotent on (asset, reason, ref).
   */
  async function postOn(tx: any, userId: string, asset: Asset, delta: number, reason: string, ref?: string): Promise<boolean> {
    assertRef(reason, ref);
    const rows = await tx
      .insert(ledgerEntries)
      .values({ userId, asset, delta, reason, ref: ref ?? null })
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
    postOn,

    /** low-level append. delta may be + or -. Prefer credit()/debit(). idempotent on (asset,reason,ref). */
    async post(userId: string, asset: Asset, delta: number, reason: string, ref?: string): Promise<boolean> {
      return db.transaction((tx: any) => postOn(tx, userId, asset, delta, reason, ref));
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
