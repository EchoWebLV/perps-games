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
        // TODO(alerting): route [wallet_rebind_attempt] to the real alert sink (spec §12).
        // A rebind attempt on a real-money payout destination must page, not just log — a bare
        // console.warn must not be the only signal in a real-money deployment.
        console.warn(`[wallet_rebind_attempt] user=${id} existing=${cur.walletPublicKey} attempted=${address}`);
      }
      return cur as User;
    },
    /**
     * Sync the wallet address verified by Privy for this DID. Unlike manual source binding,
     * this follows the authenticated embedded wallet so payment txs require the same signer
     * the client will ask Privy to use.
     */
    async syncVerifiedWalletPublicKey(id: string, address: string): Promise<User> {
      const rows = await db
        .update(users)
        .set({ walletPublicKey: address })
        .where(eq(users.id, id))
        .returning();
      return rows[0];
    },
  };
}

export type Users = ReturnType<typeof makeUsers>;
