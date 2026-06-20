import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  bigint,
  index,
  integer,
  doublePrecision,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** stable external identity. dev stub: "dev:<name>". Privy (1.3): the Privy DID. */
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdx: uniqueIndex("users_external_id_idx").on(t.externalId),
  }),
);

export type User = typeof users.$inferSelect;

/** append-only money ledger. balance = sum(delta). amounts are INTEGER coins. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** signed integer coins: credit > 0, debit < 0 */
    delta: bigint("delta", { mode: "number" }).notNull(),
    /** why this entry exists, e.g. "dev_grant" | "round_stake" | "round_payout" */
    reason: text("reason").notNull(),
    /** optional trace/idempotency reference (round id, crate id, deposit tx, ...) */
    ref: text("ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("ledger_user_idx").on(t.userId),
    // idempotency: a (reason, ref) pair posts at most once (ref is optional).
    idemIdx: uniqueIndex("ledger_idem_idx").on(t.reason, t.ref).where(sql`${t.ref} is not null`),
  }),
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

/** unlock-only car ownership. one row per owned car; cannot own the same car twice. */
export const inventory = pgTable(
  "inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    carId: text("car_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownedIdx: uniqueIndex("inventory_user_car_idx").on(t.userId, t.carId),
  }),
);

export type InventoryRow = typeof inventory.$inferSelect;

export const roundStatus = pgEnum("round_status", ["open", "settled"]);

/**
 * Authoritative server-side round. One row per round; settlement transitions
 * open → settled exactly once. Prices are doublePrecision (audit/telemetry);
 * only money columns (stake, payout) are integer bigint.
 */
export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    asset: text("asset").notNull(), // "SOL" | "BTC" | "ETH"
    dir: integer("dir").notNull(), // 1 long, -1 short (the OPEN direction)
    lev: integer("lev").notNull(), // OPEN leverage (post-niceLev; integer)
    stake: bigint("stake", { mode: "number" }).notNull(), // integer coins debited at open

    // effective per-round config, SNAPSHOTTED at open (defeats the mutable-CONFIG hazard)
    cfgEdge: doublePrecision("cfg_edge").notNull(),
    cfgLiq: doublePrecision("cfg_liq").notNull(),
    cfgCap: integer("cfg_cap").notNull(),
    cfgMaxsec: integer("cfg_maxsec").notNull(),

    // server-stamped oracle entry (price + oracle timestamp in µs, NOT wall clock)
    entryRaw: doublePrecision("entry_raw").notNull(),
    entryTsUs: bigint("entry_ts_us", { mode: "number" }).notNull(),

    status: roundStatus("status").notNull().default("open"),

    // populated at settle (null while open)
    exitRaw: doublePrecision("exit_raw"),
    exitTsUs: bigint("exit_ts_us", { mode: "number" }),
    outcome: text("outcome"), // "cashout" | "cap" | "time" | "liq"
    equity: doublePrecision("equity"), // audit only
    payoutCoins: bigint("payout_coins", { mode: "number" }),
    settledAt: timestamp("settled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("rounds_user_idx").on(t.userId),
    // at most one OPEN round per user (MVP single-round guard; relax later for concurrency)
    oneOpenPerUser: uniqueIndex("rounds_one_open_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'open'`),
  }),
);

export type Round = typeof rounds.$inferSelect;

/**
 * Append-only log of server-stamped mid-round actions (flip / lever / bonus).
 * Settlement folds these in seq order over the open anchor. Idempotent on
 * (round_id, action_id): a retried action posts at most once.
 */
export const roundActions = pgTable(
  "round_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => rounds.id),
    actionId: text("action_id").notNull(), // client-supplied uuid for idempotency
    seq: integer("seq").notNull(), // application order within the round
    kind: text("kind").notNull(), // "flip" | "lever" | "bonus"
    dir: integer("dir"), // flip target direction
    lev: integer("lev"), // lever target leverage
    amount: doublePrecision("amount"), // bonus equity units
    priceRaw: doublePrecision("price_raw").notNull(), // server-stamped oracle price
    tsUs: bigint("ts_us", { mode: "number" }).notNull(), // server-stamped oracle ts (µs)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roundSeqIdx: uniqueIndex("round_actions_round_seq_idx").on(t.roundId, t.seq),
    idemIdx: uniqueIndex("round_actions_idem_idx").on(t.roundId, t.actionId),
  }),
);

export type RoundAction = typeof roundActions.$inferSelect;
