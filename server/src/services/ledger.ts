import { eq, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

function assertPositiveInt(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive integer coin amount, got ${amount}`);
  }
}

export function makeLedger(db: any) {
  // shared balance query (closure so callers/methods reuse it without `this` binding)
  async function balanceWith(q: any, userId: string): Promise<number> {
    const rows = await q
      .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, userId));
    return Number(rows[0]?.bal ?? 0);
  }

  return {
    /** current balance = sum of all deltas for the user (0 if none) */
    async balance(userId: string): Promise<number> {
      return balanceWith(db, userId);
    },

    /** low-level append. delta may be + or -. Prefer credit()/debit(). idempotent on (reason, ref). */
    async post(userId: string, delta: number, reason: string, ref?: string): Promise<void> {
      await db.insert(ledgerEntries).values({ userId, delta, reason, ref: ref ?? null }).onConflictDoNothing();
    },

    async credit(userId: string, amount: number, reason: string, ref?: string): Promise<void> {
      assertPositiveInt(amount, "credit amount");
      await db.insert(ledgerEntries).values({ userId, delta: amount, reason, ref: ref ?? null }).onConflictDoNothing();
    },

    async canAfford(userId: string, amount: number): Promise<boolean> {
      return (await balanceWith(db, userId)) >= amount;
    },

    /**
     * Atomically debit `amount` coins, refusing to overdraw.
     * Serializes concurrent balance mutations for this user with a
     * transaction-scoped Postgres advisory lock, so two simultaneous debits
     * cannot both pass the balance check and overdraw.
     */
    async debit(userId: string, amount: number, reason: string, ref?: string): Promise<void> {
      assertPositiveInt(amount, "debit amount");
      await db.transaction(async (tx: any) => {
        // lock this user's "money" critical section for the txn
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        const bal = await balanceWith(tx, userId);
        if (bal < amount) throw new Error("insufficient balance");
        // idempotent: a duplicate (reason, ref) no-ops instead of double-debiting.
        await tx.insert(ledgerEntries).values({ userId, delta: -amount, reason, ref: ref ?? null }).onConflictDoNothing();
      });
    },
  };
}

export type Ledger = ReturnType<typeof makeLedger>;
