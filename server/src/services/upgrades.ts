import { eq, sql } from "drizzle-orm";
import { upgradeLevels } from "../db/schema.js";
import { upgradeCost, MAX_UPGRADE_LEVEL, type UpgradeTrack } from "@perps/engine";
import type { Ledger } from "./ledger.js";

export interface Levels { turbo: number; tank: number; suspension: number; }
const ZERO: Levels = { turbo: 0, tank: 0, suspension: 0 };
const TRACKS: UpgradeTrack[] = ["turbo", "tank", "suspension"];

export function makeUpgrades(db: any, ledger: Ledger) {
  async function get(userId: string): Promise<Levels> {
    const rows = await db.select().from(upgradeLevels).where(eq(upgradeLevels.userId, userId)).limit(1);
    if (!rows.length) return { ...ZERO };
    const r = rows[0];
    return { turbo: r.turbo, tank: r.tank, suspension: r.suspension };
  }
  return {
    get,
    /** Authoritative purchase: debit escalating cost + increment level atomically. Level and cost come
     *  from the server's own record, so the client cannot fake a level or skip the coin cost. */
    async buy(userId: string, track: UpgradeTrack): Promise<{ track: UpgradeTrack; level: number; coins: number }> {
      if (!TRACKS.includes(track)) throw new Error("bad_track");
      return db.transaction(async (tx: any) => {
        // serialize concurrent buys for this user (mirror ledger.ts advisory-lock idiom; avoids FOR UPDATE)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId} || ':upgrade', 0))`);
        await tx.insert(upgradeLevels).values({ userId }).onConflictDoNothing();
        const rows = await tx.select().from(upgradeLevels).where(eq(upgradeLevels.userId, userId)).limit(1);
        const cur = rows[0][track] as number;
        if (cur >= MAX_UPGRADE_LEVEL) throw new Error("max_level");
        const cost = upgradeCost(cur);
        await ledger.debitOn(tx, userId, "coin", cost, "upgrade_buy", `upgrade:${userId}:${track}:${cur}`); // throws "insufficient balance"
        await tx.update(upgradeLevels).set({ [track]: cur + 1, updatedAt: new Date() }).where(eq(upgradeLevels.userId, userId));
        const coins = await ledger.balanceOn(tx, userId, "coin");
        return { track, level: cur + 1, coins };
      });
    },
    /** Migration seed: set levels directly (used once when a signed-in account is server-empty and the
     *  client offers its local levels). Never debits — coins were already spent client-side. */
    async seed(userId: string, levels: Partial<Levels>): Promise<Levels> {
      const clamp = (n: unknown) => Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(Number(n) || 0)));
      const next = { turbo: clamp(levels.turbo), tank: clamp(levels.tank), suspension: clamp(levels.suspension) };
      await db.insert(upgradeLevels).values({ userId, ...next })
        .onConflictDoUpdate({ target: upgradeLevels.userId, set: { ...next, updatedAt: new Date() } });
      return next;
    },
  };
}
export type Upgrades = ReturnType<typeof makeUpgrades>;
