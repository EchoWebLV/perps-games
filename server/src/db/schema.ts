import { pgTable, uuid, text, timestamp, uniqueIndex, bigint, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** stable external identity. dev stub: "dev:<name>". Privy (1.3): the Privy DID. */
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdx: uniqueIndex("users_external_id_idx").on(t.externalId),
  }),
);

export type User = typeof users.$inferSelect;

/** append-only money ledger. balance = sum(delta). amounts are INTEGER coins. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** signed integer coins: credit > 0, debit < 0 */
    delta: bigint("delta", { mode: "number" }).notNull(),
    /** why this entry exists, e.g. "dev_grant" | "round_stake" | "round_payout" */
    reason: text("reason").notNull(),
    /** optional trace/idempotency reference (round id, crate id, deposit tx, ...) */
    ref: text("ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("ledger_user_idx").on(t.userId),
    // idempotency: a (reason, ref) pair posts at most once (ref is optional).
    idemIdx: uniqueIndex("ledger_idem_idx").on(t.reason, t.ref).where(sql`${t.ref} is not null`),
  }),
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
