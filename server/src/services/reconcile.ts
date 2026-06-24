import { sql, eq, and, ne } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

/** Returns the treasury USDC ATA balance in base units. */
export type ReadTreasuryBaseUnits = () => Promise<bigint>;

export function makeReconcile(db: any, readTreasury: ReadTreasuryBaseUnits, houseUserId: string) {
  async function sumCash(where: any): Promise<number> {
    const rows = await db
      .select({ bal: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
      .from(ledgerEntries)
      .where(where);
    return Number(rows[0]?.bal ?? 0);
  }
  return {
    async solvency() {
      // liabilities = what PLAYERS are owed (everyone EXCEPT the house). The house's own balance
      // is its equity buffer, not a liability — including it would hide under-capitalization.
      const liabilitiesCents = await sumCash(and(eq(ledgerEntries.asset, "cash"), ne(ledgerEntries.userId, houseUserId)));
      // bankroll = the house account's cash; runs NEGATIVE when the house owes more than it holds.
      const bankrollCents = await sumCash(and(eq(ledgerEntries.asset, "cash"), eq(ledgerEntries.userId, houseUserId)));
      const raw = await readTreasury();
      const onChainCents = Number(raw - (raw % 10_000n)) / 10_000; // floor to whole cents (tolerate dust)
      const deficitCents = Math.max(0, liabilitiesCents - onChainCents);
      // conservation: the vault should equal players + house (allowing ≤1¢ for the floor above).
      const conserved = Math.abs(onChainCents - (liabilitiesCents + bankrollCents)) <= 1;
      return { liabilitiesCents, bankrollCents, onChainCents, deficitCents, solvent: deficitCents === 0, conserved };
    },
  };
}
