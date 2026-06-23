import { sql, eq } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

/** Returns the treasury USDC ATA balance in base units. */
export type ReadTreasuryBaseUnits = () => Promise<bigint>;

export function makeReconcile(db: any, readTreasury: ReadTreasuryBaseUnits) {
  return {
    async solvency() {
      const rows = await db
        .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.asset, "cash"));
      const ledgerCents = Number(rows[0]?.bal ?? 0);
      const raw = await readTreasury();
      const onChainCents = Number(raw - (raw % 10_000n)) / 10_000; // floor to whole cents (tolerate dust)
      const deficitCents = Math.max(0, ledgerCents - onChainCents);
      return { ledgerCents, onChainCents, deficitCents, healthy: deficitCents === 0 };
    },
  };
}
