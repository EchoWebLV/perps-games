import { randomUUID } from "node:crypto";
import { and, eq, asc, sql } from "drizzle-orm";
import { rounds, roundActions, type Round, type RoundAction } from "../db/schema.js";
import { BASE_CONFIG, settleRound, bufferOf, type Action, type Dir, type SettleResult } from "@perps/engine";
import type { Ledger } from "./ledger.js";
import type { PriceFeed } from "../feed/types.js";
import { FeedHaltError, OpenRoundExistsError, RoundNotFoundError, RoundClosedError } from "./errors.js";

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
  /** injectable wall clock (ms) for the mark-freshness window; defaults to Date.now */
  nowMs?: () => number;
}

// Stakes are in cents (1 coin = $0.01). MIN is a permissive 1¢ safety floor — the
// product minimum ($0.25) is enforced client-side; MAX is the $50.00 cap.
const MIN_STAKE = 1;
const MAX_STAKE = 5000;

export function makeRounds(deps: RoundsDeps) {
  const { db, ledger, feed } = deps;
  const now = deps.nowMs ?? (() => Date.now());
  // The last price/ts the server SHOWED the client via mark(), per open round. close() settles at
  // this (when fresh) so "what you see == what you settle for" — not a newer feed tick. Cleared on
  // close. (Abandoned rounds leave a stale entry until the 1.4 settler; bounded by active rounds.)
  const MARK_FRESH_MS = 1500;
  const lastMark = new Map<string, { exitRaw: number; exitTsUs: number; atMs: number }>();

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

  /** map a stored action row to the engine's pure Action shape */
  function toEngineAction(a: RoundAction): Action {
    if (a.kind === "flip") return { kind: "flip", dir: a.dir as Dir, priceRaw: a.priceRaw, tsUs: a.tsUs };
    if (a.kind === "lever") return { kind: "lever", lev: a.lev as number, priceRaw: a.priceRaw, tsUs: a.tsUs };
    return { kind: "bonus", amount: a.amount as number, priceRaw: a.priceRaw, tsUs: a.tsUs };
  }

  async function loadRoundActions(q: any, roundId: string): Promise<RoundAction[]> {
    return q.select().from(roundActions).where(eq(roundActions.roundId, roundId)).orderBy(asc(roundActions.seq));
  }

  async function requireRound(q: any, userId: string, roundId: string): Promise<Round> {
    const rows = await q.select().from(rounds).where(and(eq(rounds.id, roundId), eq(rounds.userId, userId))).limit(1);
    if (!rows.length) throw new RoundNotFoundError();
    return rows[0] as Round;
  }

  async function action(
    userId: string,
    roundId: string,
    p: { actionId: string; kind: "flip" | "lever"; dir?: Dir; lev?: number },
  ): Promise<{ round: Round; actions: RoundAction[] }> {
    // validate the action shape
    if (p.kind === "flip" && p.dir !== 1 && p.dir !== -1) throw new Error("flip requires dir 1 or -1");
    if (p.kind === "lever" && (!Number.isInteger(p.lev) || (p.lev as number) < BASE_CONFIG.RMIN || (p.lev as number) > BASE_CONFIG.RMAX))
      throw new Error(`lever requires an integer lev in [${BASE_CONFIG.RMIN}, ${BASE_CONFIG.RMAX}]`);

    // load the round once to learn its asset, then HALT-check + stamp the server price
    const pre = await requireRound(db, userId, roundId);
    if (!feed.healthy(pre.asset)) throw new FeedHaltError();
    const { price: priceRaw, tsUs } = feed.current(pre.asset);

    await db.transaction(async (tx: any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const round = await requireRound(tx, userId, roundId);
      if (round.status !== "open") throw new RoundClosedError();
      const existing = await loadRoundActions(tx, roundId);
      const seq = existing.length + 1;
      await tx
        .insert(roundActions)
        .values({
          roundId,
          actionId: p.actionId,
          seq,
          kind: p.kind,
          dir: p.kind === "flip" ? p.dir : null,
          lev: p.kind === "lever" ? p.lev : null,
          amount: null,
          priceRaw,
          tsUs,
        })
        .onConflictDoNothing(); // idempotent on (round_id, action_id)
    });

    const round = await requireRound(db, userId, roundId);
    const actions = await loadRoundActions(db, roundId);
    return { round, actions };
  }

  function cfgOf(round: Round) {
    return { EDGE: round.cfgEdge, LIQ: round.cfgLiq, CAP: round.cfgCap, MAXSEC: round.cfgMaxsec, RMIN: BASE_CONFIG.RMIN, RMAX: BASE_CONFIG.RMAX };
  }

  /** rebuild the settle result that was stored on an already-settled round (for idempotent replay) */
  function storedResult(round: Round): SettleResult {
    const payoutCoins = round.payoutCoins ?? 0;
    return { outcome: round.outcome as SettleResult["outcome"], equity: round.equity ?? 0, payoutCoins, pnlCoins: payoutCoins - round.stake };
  }

  // `reason` is accepted-but-ignored telemetry (the client's stated intent). The authoritative
  // outcome is derived purely from the server-stamped price/time marks in settleRound — a client
  // claiming "expire" cannot force a "time" outcome, nor "cashout" avoid a liquidation.
  async function close(userId: string, roundId: string, reason: "cashout" | "expire"): Promise<SettleResult & { round: Round }> {
    const pre = await requireRound(db, userId, roundId);
    if (!feed.healthy(pre.asset)) throw new FeedHaltError();
    // settle at the price the client was last SHOWN (mark), if fresh; else a fresh feed read.
    const fresh = feed.current(pre.asset);
    const shown = lastMark.get(roundId);
    const useShown = !!shown && now() - shown.atMs < MARK_FRESH_MS;
    const exitRaw = useShown ? shown!.exitRaw : fresh.price;
    const exitTsUs = useShown ? shown!.exitTsUs : fresh.tsUs;

    return db.transaction(async (tx: any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const round = await requireRound(tx, userId, roundId);

      if (round.status === "settled") {
        // idempotent replay — return the stored result, do NOT pay again
        return { ...storedResult(round), round };
      }

      const rows = await loadRoundActions(tx, roundId);
      const actions: Action[] = rows.map(toEngineAction);
      const result = settleRound({
        openDir: round.dir as Dir,
        openLev: round.lev,
        entryRaw: round.entryRaw,
        entryTsUs: round.entryTsUs,
        stake: round.stake,
        actions,
        exitRaw,
        exitTsUs,
        cfg: cfgOf(round),
      });

      // single-writer: transition only if still open (the WHERE guard + the lock make it one-shot)
      await tx
        .update(rounds)
        .set({
          status: "settled",
          exitRaw,
          exitTsUs,
          outcome: result.outcome,
          equity: result.equity,
          payoutCoins: result.payoutCoins,
          settledAt: new Date(),
        })
        .where(and(eq(rounds.id, roundId), eq(rounds.status, "open")));

      // pay winnings (skip on 0 — credit rejects 0). Idempotent on (round_payout, roundId).
      if (result.payoutCoins > 0) {
        await ledger.creditOn(tx, userId, result.payoutCoins, "round_payout", roundId);
      }
      lastMark.delete(roundId); // settled — drop the shown-mark cache

      const settled = await requireRound(tx, userId, roundId);
      return { ...result, round: settled };
    });
  }

  /**
   * Read-only "mark": the round's CURRENT equity/payout from the server feed + recorded actions,
   * computed with the SAME settleRound code path used at close — so the live number the client
   * displays equals what it will settle for (to one server tick). Never mutates the round.
   */
  async function mark(userId: string, roundId: string): Promise<{
    status: "open" | "settled";
    stale: boolean;
    outcome: SettleResult["outcome"] | null;
    equity: number;
    payoutCoins: number;
    buffer: number;
  }> {
    const round = await requireRound(db, userId, roundId);
    if (round.status === "settled") {
      const stored = storedResult(round);
      return { status: "settled", stale: false, outcome: stored.outcome, equity: stored.equity, payoutCoins: stored.payoutCoins, buffer: bufferOf(stored.equity, round.cfgLiq) };
    }
    // feed down → tell the client to FREEZE its last mark (don't snap to a bogus value)
    if (!feed.healthy(round.asset)) {
      return { status: "open", stale: true, outcome: null, equity: 1, payoutCoins: 0, buffer: 1 };
    }
    const { price, tsUs } = feed.current(round.asset);
    const rows = await loadRoundActions(db, roundId);
    const actions: Action[] = rows.map(toEngineAction);
    const result = settleRound({
      openDir: round.dir as Dir,
      openLev: round.lev,
      entryRaw: round.entryRaw,
      entryTsUs: round.entryTsUs,
      stake: round.stake,
      actions,
      exitRaw: price,
      exitTsUs: tsUs,
      cfg: cfgOf(round),
    });
    lastMark.set(roundId, { exitRaw: price, exitTsUs: tsUs, atMs: now() }); // close() settles here while fresh
    return { status: "open", stale: false, outcome: result.outcome, equity: result.equity, payoutCoins: result.payoutCoins, buffer: bufferOf(result.equity, round.cfgLiq) };
  }

  async function get(userId: string, roundId: string): Promise<Round | null> {
    const rows = await db.select().from(rounds).where(and(eq(rounds.id, roundId), eq(rounds.userId, userId))).limit(1);
    return rows.length ? (rows[0] as Round) : null;
  }

  async function getOpenRoundId(userId: string): Promise<string | null> {
    const rows = await db
      .select({ id: rounds.id })
      .from(rounds)
      .where(and(eq(rounds.userId, userId), eq(rounds.status, "open")))
      .limit(1);
    return rows.length ? (rows[0].id as string) : null;
  }

  return { open, action, close, mark, get, getOpenRoundId, toEngineAction, loadRoundActions, requireRound };
}

export type Rounds = ReturnType<typeof makeRounds>;
