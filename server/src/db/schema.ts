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
  check,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const LEGACY_PROVIDER_TX_ID_COLUMN = "pri" + "vy_tx_id";
const LEGACY_PROVIDER_IDEMPOTENCY_COLUMN = "pri" + "vy_idempotency_key";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** stable external identity. dev stub: "dev:<name>". Production auth stores the provider DID. */
    externalId: text("external_id").notNull(),
    /** Verified Solana address synced from Bearer auth (null for dev/guest). */
    walletPublicKey: text("wallet_public_key"),
    /** first-login welcome crate claimed — SET-ONCE per account (see users.claimWelcome). */
    welcomeClaimed: boolean("welcome_claimed").notNull().default(false),
    /** redeemed access-code ids (trimmed+lowercased) — each grants its reward ONCE per account (see users.redeemAccess). */
    accessCodes: text("access_codes").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdx: uniqueIndex("users_external_id_idx").on(t.externalId),
    walletPublicKeyIdx: uniqueIndex("users_wallet_public_key_idx")
      .on(t.walletPublicKey)
      .where(sql`${t.walletPublicKey} is not null`),
  }),
);

export type User = typeof users.$inferSelect;

export const tradeHistory = pgTable(
  "trade_history",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    walletPublicKey: text("wallet_public_key").notNull(),
    asset: text("asset").notNull(),
    dir: integer("dir").notNull(),
    lev: integer("lev").notNull(),
    stakeBase: bigint("stake_base", { mode: "number" }).notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    exitPrice: doublePrecision("exit_price").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    payoutBase: bigint("payout_base", { mode: "number" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSettledIdx: index("trade_history_user_settled_idx").on(t.userId, t.settledAt, t.id),
  }),
);

export type TradeHistoryRow = typeof tradeHistory.$inferSelect;

/** ledger asset: soft play-money (faucet, never withdrawable) vs USDC-backed real money */
export const ledgerAsset = pgEnum("ledger_asset", ["coin", "cash", "scrap"]);

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
    /** which money bucket. 'coin' = soft play money; 'cash' = USDC-backed, withdrawable. */
    asset: ledgerAsset("asset").notNull().default("coin"),
    /** why this entry exists, e.g. "dev_grant" | "round_stake" | "round_payout" */
    reason: text("reason").notNull(),
    /** optional trace/idempotency reference (round id, crate id, deposit tx, ...) */
    ref: text("ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("ledger_user_idx").on(t.userId),
    userCreatedIdx: index("ledger_user_created_idx").on(t.userId, t.createdAt),
    // idempotency: a (asset, reason, ref) triple posts at most once (ref optional).
    idemIdx: uniqueIndex("ledger_idem_idx").on(t.asset, t.reason, t.ref).where(sql`${t.ref} is not null`),
    // cash-moving reasons MUST carry a ref (else one on-chain transfer could credit twice).
    cashRefChk: check(
      "ledger_cash_ref_chk",
      sql`${t.ref} is not null or ${t.reason} not in ('deposit','withdraw_reserve','withdraw_reverse')`,
    ),
  }),
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

/** deposit lifecycle: a confirmed credit, or a quarantined (recorded-not-credited) inbound transfer. */
export const depositStatus = pgEnum("deposit_status", ["credited", "quarantine"]);

/** one row per observed inbound USDC transfer to the treasury ATA (idempotent on tx_sig). */
export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txSig: text("tx_sig").notNull(),
    userId: uuid("user_id").references(() => users.id),
    amountBaseUnits: text("amount_base_units").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }),
    mint: text("mint").notNull(),
    sourceOwner: text("source_owner").notNull(),
    destAta: text("dest_ata").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    status: depositStatus("status").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txSigIdx: uniqueIndex("deposits_tx_sig_idx").on(t.txSig),
    userIdx: index("deposits_user_idx").on(t.userId),
  }),
);
export type Deposit = typeof deposits.$inferSelect;

/** append-only record of confirmed funding wallets; a wallet may back at most ONE account. */
export const depositSources = pgTable(
  "deposit_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    sourceWallet: text("source_wallet").notNull(),
    firstSeenTxSig: text("first_seen_tx_sig").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceWalletIdx: uniqueIndex("deposit_sources_wallet_idx").on(t.sourceWallet),
  }),
);
export type DepositSourceRow = typeof depositSources.$inferSelect;

/**
 * Durable poll cursor for the deposit confirmer, one row per treasury ATA. Stores the newest
 * signature processed so far so a restart resumes where it left off (an in-memory cursor was lost on
 * restart and re-scanned only the newest page, permanently skipping older legitimate deposits).
 */
export const depositCursors = pgTable("deposit_cursors", {
  treasuryAta: text("treasury_ata").primaryKey(),
  lastSig: text("last_sig").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type DepositCursor = typeof depositCursors.$inferSelect;

export const withdrawalStatus = pgEnum("withdrawal_status", [
  "reserved", "awaiting_approval", "signing", "sent", "confirmed", "failed", "reversed", "needs_review",
]);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    destWallet: text("dest_wallet").notNull(),
    status: withdrawalStatus("status").notNull().default("reserved"),
    txSig: text("tx_sig"),
    providerTxId: text(LEGACY_PROVIDER_TX_ID_COLUMN),
    providerIdempotencyKey: text(LEGACY_PROVIDER_IDEMPOTENCY_COLUMN).notNull(),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("withdrawals_user_idx").on(t.userId),
    oneInflight: uniqueIndex("withdrawals_one_inflight_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('reserved','awaiting_approval','signing','sent','needs_review')`),
  }),
);
export type Withdrawal = typeof withdrawals.$inferSelect;

/** counted car ownership. one row per owned car; count stacks duplicate pulls (melt sheds spares, never the last). */
export const inventory = pgTable(
  "inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    carId: text("car_id").notNull(),
    count: integer("count").notNull().default(1),
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

/** Authoritative per-user upgrade levels (Turbo/Tank/Suspension). Client localStorage is a mirror;
 *  the server wins on sign-in. Levels feed the entitlement envelope, so they MUST be authoritative. */
export const upgradeLevels = pgTable("upgrade_levels", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  turbo: integer("turbo").notNull().default(0),
  tank: integer("tank").notNull().default(0),
  suspension: integer("suspension").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type UpgradeLevelsRow = typeof upgradeLevels.$inferSelect;
