import { createDb, type Db } from "../db/client.js";
import { makeUsers, type Users } from "../services/users.js";
import { makeLedger, type Ledger } from "../services/ledger.js";
import { makeInventory, type Inventory } from "../services/inventory.js";
import { makeRounds, type Rounds } from "../services/rounds.js";
import { ensureHouseUserId } from "../services/house.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";
import { buildServer } from "../http/server.js";
import { makeSessionAuth, type SessionAuth } from "../auth/session.js";
import { createWalletBinding, type WalletBinding } from "../auth/wallet-binding.js";

export interface TestCtx {
  raw: Db;
  db: any;
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  rounds: Rounds;
  feed: StubFeed;
  houseUserId: string;
  server: ReturnType<typeof buildServer>;
  close(): Promise<void>;
}

/** fresh in-memory pglite DB with migrations applied + services wired (stub feed) */
export async function makeTestDb(opts: { signupFaucet?: boolean; startBalance?: number; corsOrigins?: string[]; devAuth?: boolean; sessionAuth?: SessionAuth; walletBinding?: WalletBinding; realMoney?: { enabled: boolean; treasuryUsdcAta: string | null }; depositTxBuilder?: import("../services/deposit-tx.js").DepositTxBuilder | null; walletBalanceReader?: import("../services/wallet-balance.js").WalletBalanceReader | null; depositIntents?: { create(input: { userId: string; wallet: string; amountCents: number; txBase64: string }): { depositIntent: string; expiresAt: string }; verify(depositIntent: string): { userId: string; wallet: string; amountCents: number; txBase64: string } | null }; signedTxBroadcaster?: { broadcastSignedDeposit(input: { expectedTxBase64: string; signedTxBase64: string }): Promise<{ txSig: string }> } | null; depositMinCents?: number; depositMaxCents?: number; withdrawals?: any; withdrawProcessor?: any; payoutSigner?: import("../solana/withdraw-signer.js").WithdrawSigner | null; stakeAsset?: "coin" | "cash" } = {}): Promise<TestCtx> {
  const raw = createDb(); // pglite
  await raw.runMigrations();
  const db = raw.db;

  const users = makeUsers(db);
  const ledger = makeLedger(db);
  const inventory = makeInventory(db);
  const feed = makeStubFeed();
  const stakeAsset = opts.stakeAsset ?? "coin";
  const houseUserId = await ensureHouseUserId(users);
  const rounds = makeRounds({ db, ledger, feed, stakeAsset, houseUserId });

  const server = buildServer({
    users, ledger, inventory, rounds, feed,
    stakeAsset,
    devEndpoints: true,
    signupFaucet: opts.signupFaucet ?? false,
    startBalance: opts.startBalance ?? 100,
    corsOrigins: opts.corsOrigins ?? ["http://localhost:3000"],
    devAuth: opts.devAuth ?? true,
    sessionAuth: opts.sessionAuth ?? makeSessionAuth({
      users,
      secret: "test-session-secret-32-characters-long",
    }),
    walletBinding: opts.walletBinding ?? createWalletBinding({
      secret: "test-wallet-binding-secret-32-chars",
    }),
    realMoney: opts.realMoney ?? { enabled: false, treasuryUsdcAta: null },
    depositTxBuilder: opts.depositTxBuilder ?? null,
    walletBalanceReader: opts.walletBalanceReader ?? null,
    depositIntents: opts.depositIntents ?? {
      create({ userId, wallet, amountCents, txBase64 }) {
        return {
          depositIntent: `intent:${userId}:${wallet}:${amountCents}:${txBase64}`,
          expiresAt: new Date(60_000).toISOString(),
        };
      },
      verify(depositIntent) {
        const [, userId, wallet, amountCents, txBase64] = depositIntent.split(":");
        if (!userId || !wallet || !amountCents || !txBase64) return null;
        return { userId, wallet, amountCents: Number(amountCents), txBase64 };
      },
    },
    signedTxBroadcaster: opts.signedTxBroadcaster ?? null,
    depositMinCents: opts.depositMinCents ?? 10,
    depositMaxCents: opts.depositMaxCents ?? 10000,
    withdrawals: opts.withdrawals ?? null,
    withdrawProcessor: opts.withdrawProcessor ?? null,
    payoutSigner: opts.payoutSigner ?? null,
  } as any);

  return { raw, db, users, ledger, inventory, rounds, feed, houseUserId, server, close: () => raw.close() };
}
