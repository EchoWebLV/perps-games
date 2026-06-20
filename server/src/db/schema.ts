import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
