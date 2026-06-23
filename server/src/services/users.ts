import { eq, and, isNull } from "drizzle-orm";
import { users, type User } from "../db/schema.js";

export function makeUsers(db: any) {
  return {
    /** find-or-create a user by external identity */
    async upsertByExternalId(externalId: string): Promise<User> {
      const existing = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
      if (existing[0]) return existing[0];
      const inserted = await db
        .insert(users)
        .values({ externalId })
        .onConflictDoNothing({ target: users.externalId })
        .returning();
      if (inserted[0]) return inserted[0];
      // lost a race: re-read
      const reread = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
      return reread[0];
    },
    async get(id: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0];
    },
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
  };
}

export type Users = ReturnType<typeof makeUsers>;
