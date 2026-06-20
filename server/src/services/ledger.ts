import { eq, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

function assertPositiveInt(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive integer coin amount, got ${amount}`);
  }
}

export function makeLedger(db: any) {
  /** balance using a given query runner (db or an open tx) */
  async function balanceOn(q: any, userId: string): Promise<number> {
    const rows = await q
      .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, userId));
    return Number(rows[0]?.bal ?? 0);
  }

  /** lock + balance-check + append, WITHIN a caller-provided tx (atomic with sibling writes) */
  async function debitOn(tx: any, userId: string, amount: number, reason: string, ref?: string): Promise<void> {
    assertPositiveInt(amount, "debit amount");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const bal = await balanceOn(tx, userId);
    if (bal < amount) throw new Error("insufficient balance");
    await tx.insert(ledgerEntries).values({ userId, delta: -amount, reason, ref: ref ?? null }).onConflictDoNothing();
  }

  /** append a credit WITHIN a caller-provided tx (idempotent on (reason, ref)) */
  async function creditOn(tx: any, userId: string, amount: number, reason: string, ref?: string): Promise<void> {
    assertPositiveInt(amount, "credit amount");
    await tx.insert(ledgerEntries).values({ userId, delta: amount, reason, ref: ref ?? null }).onConflictDoNothing();
  }

  return {
    /** current balance = sum of all deltas for the user (0 if none) */
    async balance(userId: string): Promise<number> {
      return balanceOn(db, userId);
    },
    balanceOn,
    debitOn,
    creditOn,

    /** low-level append. delta may be + or -. Prefer credit()/debit(). idempotent on (reason, ref). */
    async post(userId: string, delta: number, reason: string, ref?: string): Promise<void> {
      await db.insert(ledgerEntries).values({ userId, delta, reason, ref: ref ?? null }).onConflictDoNothing();
    },

    async credit(userId: string, amount: number, reason: string, ref?: string): Promise<void> {
      assertPositiveInt(amount, "credit amount");
      await db.insert(ledgerEntries).values({ userId, delta: amount, reason, ref: ref ?? null }).onConflictDoNothing();
    },

    async canAfford(userId: string, amount: number): Promise<boolean> {
      return (await balanceOn(db, userId)) >= amount;
    },

    /**
     * Atomically debit `amount` coins, refusing to overdraw. Serializes concurrent
     * balance mutations for this user with a transaction-scoped advisory lock.
     */
    async debit(userId: string, amount: number, reason: string, ref?: string): Promise<void> {
      await db.transaction((tx: any) => debitOn(tx, userId, amount, reason, ref));
    },
  };
}

export type Ledger = ReturnType<typeof makeLedger>;
