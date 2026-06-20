import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { rounds, roundActions, type Round } from "../db/schema.js";
import { BASE_CONFIG, type Dir } from "@perps/engine";
import type { Ledger } from "./ledger.js";
import type { PriceFeed } from "../feed/types.js";
import { FeedHaltError, OpenRoundExistsError } from "./errors.js";

export interface OpenInput {
  asset: string;
  dir: Dir;
  lev: number;
  stake: number;
}

export interface RoundsDeps {
  db: any;
  ledger: Ledger;
  feed: PriceFeed;
}

const MIN_STAKE = 1;
const MAX_STAKE = 50;

export function makeRounds(deps: RoundsDeps) {
  const { db, ledger, feed } = deps;

  function validateOpen(p: OpenInput): void {
    if (p.dir !== 1 && p.dir !== -1) throw new Error("dir must be 1 or -1");
    if (!Number.isInteger(p.lev) || p.lev < BASE_CONFIG.RMIN || p.lev > BASE_CONFIG.RMAX)
      throw new Error(`lev must be an integer in [${BASE_CONFIG.RMIN}, ${BASE_CONFIG.RMAX}]`);
    if (!Number.isInteger(p.stake) || p.stake < MIN_STAKE || p.stake > MAX_STAKE)
      throw new Error(`stake must be an integer in [${MIN_STAKE}, ${MAX_STAKE}]`);
  }

  async function open(userId: string, p: OpenInput): Promise<Round> {
    validateOpen(p);
    if (!feed.healthy(p.asset)) throw new FeedHaltError();
    const { price: entryRaw, tsUs: entryTsUs } = feed.current(p.asset);
    const cfg = BASE_CONFIG;
    const roundId = randomUUID();

    await db.transaction(async (tx: any) => {
      // debitOn takes the per-user advisory lock; the open-round check below is race-free under it.
      await ledger.debitOn(tx, userId, p.stake, "round_stake", roundId);
      const existing = await tx
        .select({ id: rounds.id })
        .from(rounds)
        .where(and(eq(rounds.userId, userId), eq(rounds.status, "open")))
        .limit(1);
      if (existing.length) throw new OpenRoundExistsError(); // rolls back the debit
      await tx.insert(rounds).values({
        id: roundId,
        userId,
        asset: p.asset,
        dir: p.dir,
        lev: p.lev,
        stake: p.stake,
        cfgEdge: cfg.EDGE,
        cfgLiq: cfg.LIQ,
        cfgCap: cfg.CAP,
        cfgMaxsec: cfg.MAXSEC,
        entryRaw,
        entryTsUs,
        status: "open",
      });
    });

    const row = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
    return row[0] as Round;
  }

  return { open };
}

export type Rounds = ReturnType<typeof makeRounds>;
