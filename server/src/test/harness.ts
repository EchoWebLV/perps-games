import { createDb, type Db } from "../db/client.js";
import { makeUsers, type Users } from "../services/users.js";
import { makeLedger, type Ledger } from "../services/ledger.js";
import { makeInventory, type Inventory } from "../services/inventory.js";
import { makeRounds, type Rounds } from "../services/rounds.js";
import { makeUpgrades, type Upgrades } from "../services/upgrades.js";
import { makeCrateOpen } from "../services/crate-open.js";
import { makeEntitlements, type Entitlements } from "../services/entitlements.js";
import { makeEarnLimit, type EarnLimit } from "../services/earn-limit.js";
import { makeTradeHistory, type TradeHistory } from "../services/trade-history.js";
import { ensureHouseUserId } from "../services/house.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";
import { buildServer } from "../http/server.js";
import { makeSessionAuth, type SessionAuth } from "../auth/session.js";
import { createWalletBinding, type WalletBinding } from "../auth/wallet-binding.js";
import { makeDepositIntents, type DepositIntents } from "../services/deposit-intents.js";
import type { SignedTxBroadcaster } from "../services/signed-tx-broadcaster.js";
import type { Withdrawals } from "../services/withdrawals.js";
import type { WithdrawProcessor, WithdrawSigner } from "../services/withdraw-worker.js";
import { makePresenceRoom, type PresenceRoom } from "../presence/room.js";

export interface TestCtx {
  raw: Db;
  db: any;
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  rounds: Rounds;
  tradeHistory: TradeHistory;
  feed: StubFeed;
  houseUserId: string;
  upgrades: Upgrades;
  entitlements: Entitlements;
  earnLimit: EarnLimit;
  sessionAuth: SessionAuth;
  presenceRoom: PresenceRoom;
  server: ReturnType<typeof buildServer>;
  close(): Promise<void>;
}

interface MakeTestDbOptions {
  signupFaucet?: boolean;
  startBalance?: number;
  corsOrigins?: string[];
  devAuth?: boolean;
  sessionAuth?: SessionAuth;
  walletBinding?: WalletBinding;
  realMoney?: { enabled: boolean; treasuryUsdcAta: string | null };
  depositTxBuilder?: import("../services/deposit-tx.js").DepositTxBuilder | null;
  walletBalanceReader?: import("../services/wallet-balance.js").WalletBalanceReader | null;
  depositIntents?: DepositIntents;
  signedTxBroadcaster?: SignedTxBroadcaster | null;
  depositMinCents?: number;
  depositMaxCents?: number;
  withdrawals?: Withdrawals | null;
  withdrawProcessor?: WithdrawProcessor | null;
  payoutSigner?: WithdrawSigner | null;
  adminSecret?: string | null;
  stakeAsset?: "coin" | "cash";
  earnLimit?: { ceiling: number; windowMs: number };
  presenceSocketOptions?: {
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    snapshotIntervalMs?: number;
    heartbeatIntervalMs?: number;
    helloTimeoutMs?: number;
  };
}

/** fresh in-memory pglite DB with migrations applied + services wired (stub feed) */
export async function makeTestDb(opts: MakeTestDbOptions = {}): Promise<TestCtx> {
  const raw = createDb(); // pglite
  await raw.runMigrations();
  const db = raw.db;

  const users = makeUsers(db);
  const tradeHistory = makeTradeHistory({ db, users });
  const ledger = makeLedger(db);
  const inventory = makeInventory(db);
  const feed = makeStubFeed();
  const stakeAsset = opts.stakeAsset ?? "coin";
  const houseUserId = await ensureHouseUserId(users);
  const rounds = makeRounds({ db, ledger, feed, stakeAsset, houseUserId });
  const upgrades = makeUpgrades(db, ledger);
  const crateOpen = makeCrateOpen(ledger, inventory, users);
  const entitlements = makeEntitlements({ inventory, upgrades });
  // deliberately huge default ceiling so unrelated suites never trip the cap; cap tests override it.
  const earnLimit = makeEarnLimit(db, opts.earnLimit ?? { ceiling: 1_000_000, windowMs: 60_000 });

  const sessionAuth = opts.sessionAuth ?? makeSessionAuth({
    users,
    secret: "test-session-secret-32-characters-long",
  });
  const presenceRoom = makePresenceRoom();
  const server = buildServer({
    users, ledger, inventory, rounds, tradeHistory, feed,
    upgrades, crateOpen, entitlements, earnLimit,
    stakeAsset,
    devEndpoints: true,
    signupFaucet: opts.signupFaucet ?? false,
    startBalance: opts.startBalance ?? 100,
    corsOrigins: opts.corsOrigins ?? ["http://localhost:3000"],
    devAuth: opts.devAuth ?? true,
    sessionAuth,
    presenceRoom,
    presenceSocketOptions: opts.presenceSocketOptions,
    walletBinding: opts.walletBinding ?? createWalletBinding({
      secret: "test-wallet-binding-secret-32-chars",
    }),
    realMoney: opts.realMoney ?? { enabled: false, treasuryUsdcAta: null },
    depositTxBuilder: opts.depositTxBuilder ?? null,
    walletBalanceReader: opts.walletBalanceReader ?? null,
    depositIntents: opts.depositIntents ?? makeDepositIntents({
      secret: "test-deposit-intent-secret-32-bytes",
      now: () => 0,
      ttlMs: 60_000,
    }),
    signedTxBroadcaster: opts.signedTxBroadcaster ?? null,
    depositMinCents: opts.depositMinCents ?? 10,
    depositMaxCents: opts.depositMaxCents ?? 10000,
    withdrawals: opts.withdrawals ?? null,
    withdrawProcessor: opts.withdrawProcessor ?? null,
    payoutSigner: opts.payoutSigner ?? null,
    adminSecret: opts.adminSecret ?? null,
  });

  return {
    raw,
    db,
    users,
    ledger,
    inventory,
    rounds,
    tradeHistory,
    feed,
    houseUserId,
    upgrades,
    entitlements,
    earnLimit,
    sessionAuth,
    presenceRoom,
    server,
    close: async () => {
      await server.close();
      await raw.close();
    },
  };
}

/**
 * Bind a unique wallet to a dev-auth user (dev:<name>) so it passes requireWalletBoundUser on the
 * economy-mutating endpoints. Distinct default wallet per name (the wallet column is unique).
 */
export async function bindDevWallet(ctx: TestCtx, name: string, wallet?: string): Promise<void> {
  const u = await ctx.users.upsertByExternalId(`dev:${name}`);
  await ctx.users.setWalletPublicKey(u.id, wallet ?? `wallet-${name}`);
}
