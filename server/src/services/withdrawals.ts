import { and, eq, sql } from "drizzle-orm";
import { withdrawals, depositSources, deposits } from "../db/schema.js";
import { withdrawIdempotencyKey } from "../money/idempotency.js";
import { centsToBaseUnits } from "../money/usdc.js";
import type { Ledger } from "./ledger.js";

export interface WithdrawConfig {
  minCents: number; maxCents: number;
  userDailyCapCents: number; globalDailyCapCents: number;
  holdHours: number; quorumThresholdCents: number;
}
/** Treasury USDC ATA balance in base units (for the solvency precheck). */
export type ReadTreasuryBaseUnits = () => Promise<bigint>;

export type ReserveResult =
  | { status: "ok"; withdrawalId: string; state: "awaiting_approval" | "reserved" }
  | { status: "below_min" | "above_max" | "insufficient" | "held" | "in_flight" | "capped" | "insolvent" | "no_dest" };

const INFLIGHT = sql`status in ('reserved','awaiting_approval','signing','sent','needs_review','confirmed')`;
// a fixed key for the global withdraw lock (any constant; serialises global-cap + solvency)
const GLOBAL_LOCK = 918273645;

/** A unique-violation on the one-in-flight index: re-thrown out of the tx so the reserve-debit rolls back. */
class InFlightConflict extends Error {}

export function makeWithdrawals(db: any, ledger: Ledger, cfg: WithdrawConfig, readTreasury: ReadTreasuryBaseUnits) {
  async function sumCents(tx: any, where: any): Promise<number> {
    const r = await tx.select({ s: sql<string>`coalesce(sum(${withdrawals.amountCents}),0)` }).from(withdrawals).where(where);
    return Number(r[0]?.s ?? 0);
  }

  return {
    async reserve(userId: string, amountCents: number): Promise<ReserveResult> {
      if (amountCents < cfg.minCents) return { status: "below_min" };
      if (amountCents > cfg.maxCents) return { status: "above_max" };

      try {
        return await db.transaction(async (tx: any) => {
          // global lock first, then per-(user,cash) lock — order matches the ledger's lock
          await tx.execute(sql`select pg_advisory_xact_lock(${GLOBAL_LOCK})`);
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId} || ':cash', 0))`);

          // destination binds to a CONFIRMED deposit source, never the mutable users.wallet (spec §6/§94)
          const src = await tx.select().from(depositSources).where(eq(depositSources.userId, userId)).limit(1);
          if (!src[0]) return { status: "no_dest" } as ReserveResult;
          const destWallet = src[0].sourceWallet;

          // settled cash check
          const bal = await ledger.balanceOn(tx, userId, "cash");
          if (bal < amountCents) return { status: "insufficient" } as ReserveResult;

          // deposit hold: any credited deposit newer than the hold window blocks withdrawal
          if (cfg.holdHours > 0) {
            const recent = await tx.select({ n: sql<string>`count(*)` }).from(deposits).where(and(
              eq(deposits.userId, userId), eq(deposits.status, "credited"),
              sql`${deposits.createdAt} > now() - (${cfg.holdHours} || ' hours')::interval`,
            ));
            if (Number(recent[0]?.n ?? 0) > 0) return { status: "held" } as ReserveResult;
          }

          // per-user + global 24h caps, counting in-flight + confirmed
          const userSum = await sumCents(tx, and(eq(withdrawals.userId, userId), INFLIGHT, sql`${withdrawals.createdAt} > now() - interval '24 hours'`));
          if (userSum + amountCents > cfg.userDailyCapCents) return { status: "capped" } as ReserveResult;
          const globalSum = await sumCents(tx, and(INFLIGHT, sql`${withdrawals.createdAt} > now() - interval '24 hours'`));
          if (globalSum + amountCents > cfg.globalDailyCapCents) return { status: "capped" } as ReserveResult;

          // solvency precheck: treasury must cover all in-flight outflow + this one
          const treasuryBase = await readTreasury();
          const inflightBase = centsToBaseUnits(BigInt(globalSum + amountCents));
          if (treasuryBase < inflightBase) return { status: "insolvent" } as ReserveResult;

          // reserve-debit (idempotent on (cash,withdraw_reserve,id)); throws if balance vanished
          const id = crypto.randomUUID();
          const debited = await ledger.debitOn(tx, userId, "cash", amountCents, "withdraw_reserve", id);
          if (!debited) return { status: "in_flight" } as ReserveResult; // replay — should not happen for a fresh id

          // insert the withdrawal; the partial-unique index 409s a second in-flight row
          const state = amountCents > cfg.quorumThresholdCents || cfg.quorumThresholdCents === 0 ? "awaiting_approval" : "reserved";
          try {
            await tx.insert(withdrawals).values({
              id, userId, amountCents, destWallet, status: state, privyIdempotencyKey: withdrawIdempotencyKey(id),
            });
          } catch (e: any) {
            // a unique/duplicate violation = a concurrent in-flight withdrawal. Re-throw OUT of the tx so the
            // whole transaction (incl. the reserve-debit just appended) rolls back — never leave cash debited.
            if (String(e?.message ?? e).match(/unique|duplicate/i)) throw new InFlightConflict();
            throw e;
          }
          return { status: "ok", withdrawalId: id, state } as ReserveResult;
        });
      } catch (e: any) {
        if (e instanceof InFlightConflict) return { status: "in_flight" };
        throw e;
      }
    },
  };
}

export type Withdrawals = ReturnType<typeof makeWithdrawals>;
