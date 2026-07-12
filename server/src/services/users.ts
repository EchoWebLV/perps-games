import { eq, and, isNull, ne, sql } from "drizzle-orm";
import { users, type User } from "../db/schema.js";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : String(error);
  return code === "23505" || /unique|duplicate/i.test(message);
}

function normalizeDriverName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return /^[a-z0-9_]{3,16}$/.test(name) ? name : null;
}

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
    async getByWalletPublicKey(address: string): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.walletPublicKey, address)).limit(1);
      return rows[0];
    },
    async driverName(id: string): Promise<string | null> {
      const rows = await db
        .select({ driverName: users.driverName })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows[0]?.driverName ?? null;
    },
    async setDriverName(id: string, raw: string): Promise<string> {
      const driverName = normalizeDriverName(raw);
      if (!driverName) throw new Error("invalid_driver_name");
      const rows = await db
        .update(users)
        .set({ driverName })
        .where(eq(users.id, id))
        .returning({ driverName: users.driverName });
      if (!rows[0]?.driverName) throw new Error("user_not_found");
      return rows[0].driverName;
    },
    /**
     * Bind the user's payout wallet — SET-ONCE. Only writes when currently null.
     * A second bind to a different address is a rebind attempt: ignored + alerted (returns the
     * existing row unchanged). Re-binding the same address is a harmless no-op.
     */
    async setWalletPublicKey(id: string, address: string): Promise<User> {
      const owner = await db
        .select()
        .from(users)
        .where(and(eq(users.walletPublicKey, address), ne(users.id, id)))
        .limit(1);
      if (owner[0]) throw new Error("wallet_already_bound");

      let rows: User[];
      try {
        rows = await db
          .update(users)
          .set({ walletPublicKey: address })
          .where(and(eq(users.id, id), isNull(users.walletPublicKey)))
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error("wallet_already_bound");
        throw error;
      }
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
    /** Read welcome eligibility without consuming the once-per-account claim. */
    async welcomeStatus(id: string): Promise<{ pending: boolean }> {
      const rows = await db
        .select({ welcomeClaimed: users.welcomeClaimed })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return { pending: rows[0]?.welcomeClaimed === false };
    },
    /**
     * Claim the first-login welcome crate — SET-ONCE per account. Atomic conditional UPDATE:
     * flips welcome_claimed false→true and RETURNs only when it actually moved the row, so exactly
     * one caller (the first) ever sees granted=true. Every later call, and any concurrent racer,
     * gets granted=false. Race-safe by construction (single-statement compare-and-set).
     */
    async claimWelcome(id: string): Promise<{ granted: boolean }> {
      const rows = await db
        .update(users)
        .set({ welcomeClaimed: true })
        .where(and(eq(users.id, id), eq(users.welcomeClaimed, false)))
        .returning();
      return { granted: rows.length > 0 };
    },
    /**
     * Redeem an access code — grants its reward ONCE PER (account, code). The code is normalized
     * (trimmed + lowercased) first. Atomic conditional UPDATE: appends the code to access_codes
     * only when it's absent and RETURNs only when it actually moved the row, so exactly one caller
     * (the first) ever sees granted=true. Every later call for that same (account, code), and any
     * concurrent racer, gets granted=false. Race-safe by construction (single-statement
     * compare-and-set, same shape as claimWelcome).
     */
    async redeemAccess(id: string, code: string): Promise<{ granted: boolean }> {
      const norm = code.trim().toLowerCase();
      const rows = await db
        .update(users)
        .set({ accessCodes: sql`array_append(${users.accessCodes}, ${norm})` })
        .where(and(eq(users.id, id), sql`not (${norm} = any(${users.accessCodes}))`))
        .returning({ id: users.id });
      return { granted: rows.length > 0 };
    },
    /** the account's redeemed access-code ids (normalized), or [] for a fresh account. */
    async accessCodes(id: string): Promise<string[]> {
      const rows = await db
        .select({ accessCodes: users.accessCodes })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return rows[0]?.accessCodes ?? [];
    },
  };
}

export type Users = ReturnType<typeof makeUsers>;
