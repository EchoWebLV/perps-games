import { and, desc, eq, lt, or } from "drizzle-orm";
import { tradeHistory, type TradeHistoryRow } from "../db/schema.js";
import type { Users } from "./users.js";

export type TradeAsset = "BTC" | "ETH" | "SOL";
export type TradeOutcome = "cashout" | "cap" | "liq" | "time";

export interface TradeRecordInput {
  id: string;
  asset: TradeAsset;
  dir: 1 | -1;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: Date;
  outcome: TradeOutcome;
  payoutBase: number;
}

export interface TradeHistoryItem {
  id: string;
  walletPublicKey: string;
  asset: TradeAsset;
  dir: 1 | -1;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  outcome: TradeOutcome;
  payoutBase: number;
  pnlBase: number;
  settledAt: string;
}

export interface TradeHistoryPage {
  items: TradeHistoryItem[];
  nextCursor: string | null;
}

type Cursor = { settledAt: string; id: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (row: { settledAt: Date; id: string }) =>
  Buffer.from(JSON.stringify({ settledAt: row.settledAt.toISOString(), id: row.id })).toString("base64url");

function decodeCursor(value: string): Cursor {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("bad_cursor");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !UUID_PATTERN.test(parsed.id) ||
      !("settledAt" in parsed) ||
      typeof parsed.settledAt !== "string" ||
      Number.isNaN(Date.parse(parsed.settledAt))
    ) {
      throw new Error("bad_cursor");
    }
    return { id: parsed.id, settledAt: parsed.settledAt };
  } catch {
    throw new Error("bad_cursor");
  }
}

const itemOf = (row: TradeHistoryRow): TradeHistoryItem => ({
  id: row.id,
  walletPublicKey: row.walletPublicKey,
  asset: row.asset as TradeAsset,
  dir: row.dir as 1 | -1,
  lev: row.lev,
  stakeBase: row.stakeBase,
  entryPrice: row.entryPrice,
  exitPrice: row.exitPrice,
  openedAt: row.openedAt.toISOString(),
  outcome: row.outcome as TradeOutcome,
  payoutBase: row.payoutBase,
  pnlBase: row.payoutBase - row.stakeBase,
  settledAt: row.settledAt.toISOString(),
});

export function makeTradeHistory(opts: { db: any; users: Users; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  return {
    async record(userId: string, input: TradeRecordInput): Promise<TradeHistoryItem> {
      const user = await opts.users.get(userId);
      if (!user?.walletPublicKey) throw new Error("wallet_required");
      await opts.db
        .insert(tradeHistory)
        .values({
          ...input,
          userId,
          walletPublicKey: user.walletPublicKey,
          settledAt: now(),
        })
        .onConflictDoNothing({ target: tradeHistory.id });
      const rows = await opts.db.select().from(tradeHistory).where(eq(tradeHistory.id, input.id)).limit(1);
      if (!rows[0] || rows[0].userId !== userId) throw new Error("trade_id_conflict");
      return itemOf(rows[0]);
    },

    async list(userId: string, cursor: string | undefined, limit: number): Promise<TradeHistoryPage> {
      const c = cursor === undefined ? null : decodeCursor(cursor);
      const before = c
        ? or(
            lt(tradeHistory.settledAt, new Date(c.settledAt)),
            and(eq(tradeHistory.settledAt, new Date(c.settledAt)), lt(tradeHistory.id, c.id)),
          )
        : undefined;
      const where = before
        ? and(eq(tradeHistory.userId, userId), before)
        : eq(tradeHistory.userId, userId);
      const rows = await opts.db
        .select()
        .from(tradeHistory)
        .where(where)
        .orderBy(desc(tradeHistory.settledAt), desc(tradeHistory.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: page.map(itemOf),
        nextCursor: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]) : null,
      };
    },
  };
}

export type TradeHistory = ReturnType<typeof makeTradeHistory>;
