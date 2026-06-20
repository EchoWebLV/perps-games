import { eq, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

function assertPositiveInt(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive integer coin amount, got ${amount}`);
  }
}

export function makeLedger(db: any) {
  return {
    /** current balance = sum of all deltas for the user (0 if none) */
    async balance(userId: string): Promise<number> {
      const rows = await db
        .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, userId));
      return Number(rows[0]?.bal ?? 0);
    },

    /** low-level append. delta may be + or -. Prefer credit()/debit(). idempotent on (reason, ref). */
    async post(userId: string, delta: number, reason: string, ref?: string): Promise<void> {
      await db.insert(ledgerEntries).values({ userId, delta, reason, ref: ref ?? null }).onConflictDoNothing();
    },

    async credit(userId: string, amount: number, reason: string, ref?: string): Promise<void> {
      assertPositiveInt(amount, "credit amount");
      await db.insert(ledgerEntries).values({ userId, delta: amount, reason, ref: ref ?? null }).onConflictDoNothing();
    },
  };
}

export type Ledger = ReturnType<typeof makeLedger>;
