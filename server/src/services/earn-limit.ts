import { and, eq, gte, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";
export interface EarnLimitCfg { ceiling: number; windowMs: number; }
/** Coarse anti-abuse: caps how much a user can EARN (client-reported pickups) per rolling window.
 *  Not a full economy model — just refuses implausible bursts. Server-authoritative credits (round
 *  payouts, crate purchases) use different reasons and are unaffected. */
export function makeEarnLimit(db: any, cfg: EarnLimitCfg) {
  return {
    /** true if crediting `amount` under `reason` stays within the window ceiling. */
    async check(userId: string, reason: "earn" | "scrap_earn", amount: number): Promise<boolean> {
      const since = new Date(Date.now() - cfg.windowMs);
      const rows = await db
        .select({ sum: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.reason, reason), gte(ledgerEntries.createdAt, since)));
      const windowSum = Number(rows[0]?.sum ?? 0);
      return windowSum + amount <= cfg.ceiling;
    },
  };
}
export type EarnLimit = ReturnType<typeof makeEarnLimit>;
