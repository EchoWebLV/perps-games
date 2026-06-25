import { env } from "./env.js";
import { createDb } from "./db/client.js";
import { buildServer } from "./http/server.js";
import { makeUsers } from "./services/users.js";
import { makeLedger } from "./services/ledger.js";
import { makeInventory } from "./services/inventory.js";
import { makeRounds } from "./services/rounds.js";
import { ensureHouseUserId } from "./services/house.js";
import { makeHermesFeed } from "./feed/hermes.js";
import { makeSessionAuth } from "./auth/session.js";
import { createWalletBinding } from "./auth/wallet-binding.js";
import { makeDepositTxBuilder, makeRpcBlockhash, type DepositTxBuilder } from "./services/deposit-tx.js";
import { makeDepositIntents } from "./services/deposit-intents.js";

async function main(): Promise<void> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required to start the server");
  // fail loud: dev seed endpoints must never be enabled in production
  if (env.DEV_ENDPOINTS && env.NODE_ENV === "production")
    throw new Error("refusing to boot: DEV_ENDPOINTS must not be enabled in production");

  const raw = createDb(env.DATABASE_URL);
  // Auto-migrate is a DEV convenience only. In production, migrations run as an
  // explicit pre-deploy release step (`npm run db:migrate`) — never silently
  // mutate the money tables at app boot. See migrate.ts + the Railway release command.
  if (env.NODE_ENV !== "production") await raw.runMigrations();
  const db = raw.db;

  const ledger = makeLedger(db);
  const users = makeUsers(db);
  // the house counterparty round P&L flows to/from (provisioned once, idempotent).
  const houseUserId = await ensureHouseUserId(users);

  let depositConfirmer: { start(): void; stop(): void } | undefined;
  let realMoney = { enabled: false, treasuryUsdcAta: null as string | null };
  let depositTxBuilder: DepositTxBuilder | null = null;
  let walletBalanceReader: import("./services/wallet-balance.js").WalletBalanceReader | null = null;
  let signedTxBroadcaster: import("./services/signed-tx-broadcaster.js").SignedTxBroadcaster | null = null;
  let withdrawalsSvc: import("./services/withdrawals.js").Withdrawals | undefined;
  let payoutSigner: import("./solana/withdraw-signer.js").WithdrawSigner | null = null;
  if (env.REAL_MONEY_ENABLED) {
    const { makeRpcDepositSource } = await import("./solana/deposit-source.js");
    const { assertUsdcMint } = await import("./solana/mint-assert.js");
    const { makeDeposits } = await import("./services/deposits.js");
    const { makeDepositConfirmer } = await import("./services/deposit-worker.js");
    const { makeRpcWalletBalanceReader } = await import("./services/wallet-balance.js");
    const { makeRpcSignedTxBroadcaster } = await import("./services/signed-tx-broadcaster.js");
    const source = makeRpcDepositSource(env.SOLANA_RPC_URL!);
    await assertUsdcMint((m) => source.fetchMintInfo(m), env.USDC_MINT!); // refuse to boot on a bad mint
    const deposits = makeDeposits(db, ledger, {
      usdcMint: env.USDC_MINT!, treasuryAta: env.TREASURY_USDC_ATA!,
      minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
    });
    if (env.RUN_CONFIRMER) {
      depositConfirmer = makeDepositConfirmer({ deposits, source, treasuryAta: env.TREASURY_USDC_ATA!, pollMs: env.DEPOSIT_POLL_MS });
      depositConfirmer.start();
    }
    realMoney = { enabled: true, treasuryUsdcAta: env.TREASURY_USDC_ATA! };
    signedTxBroadcaster = makeRpcSignedTxBroadcaster(env.SOLANA_RPC_URL!);

    let signFeePayerTx: ((txBase64: string) => Promise<string>) | undefined;
    let feePayerOwner = env.FEE_PAYER_OWNER_PUBKEY;
    if (env.FEE_PAYER_SECRET && env.FEE_PAYER_OWNER_PUBKEY) {
      const { makeFeePayerSigner } = await import("./solana/fee-payer-signer.js");
      const signer = await makeFeePayerSigner(env.FEE_PAYER_SECRET);
      if (signer.address !== env.FEE_PAYER_OWNER_PUBKEY) {
        throw new Error("FEE_PAYER_OWNER_PUBKEY does not match FEE_PAYER_SECRET");
      }
      if (env.TREASURY_OWNER_PUBKEY && env.FEE_PAYER_OWNER_PUBKEY === env.TREASURY_OWNER_PUBKEY) {
        throw new Error("fee payer must not be the treasury token authority");
      }
      signFeePayerTx = signer.signFeePayerTx;
    } else {
      feePayerOwner = undefined;
      console.warn("[fee_payer_disabled] falling back to user-paid Solana fees");
    }

    depositTxBuilder = makeDepositTxBuilder({
      usdcMint: env.USDC_MINT!,
      treasuryUsdcAta: env.TREASURY_USDC_ATA!,
      treasuryOwner: signFeePayerTx ? feePayerOwner : undefined,
      signFeePayerTx,
      getLatestBlockhash: makeRpcBlockhash(env.SOLANA_RPC_URL!),
    });
    walletBalanceReader = makeRpcWalletBalanceReader(env.SOLANA_RPC_URL!, env.USDC_MINT!);

    const { makeWithdrawals } = await import("./services/withdrawals.js");
    withdrawalsSvc = makeWithdrawals(db, ledger, {
      minCents: env.WITHDRAW_MIN_CENTS, maxCents: env.WITHDRAW_MAX_CENTS,
      userDailyCapCents: env.WITHDRAW_USER_DAILY_CAP_CENTS, globalDailyCapCents: env.WITHDRAW_GLOBAL_DAILY_CAP_CENTS,
      holdHours: env.WITHDRAW_HOLD_HOURS, quorumThresholdCents: env.WITHDRAW_QUORUM_THRESHOLD_CENTS,
    }, () => source.readTreasuryBaseUnits(env.TREASURY_USDC_ATA!));
    // withdrawProcessor stays null until the payout signer is reintroduced in a later task.
    // The admin-approve endpoint 404s until then.
  }
  // poll rate + HALT tolerance are tunable: the public Hermes REST endpoint can
  // rate-limit a tight 500ms poll, so a too-small stale window flaps into feed_halt.
  const feed = makeHermesFeed({
    assets: ["BTC", "ETH", "SOL"],
    pollMs: Number(process.env.FEED_POLL_MS) || undefined,
    staleMs: Number(process.env.FEED_STALE_MS) || undefined,
  });
  feed.start();
  // Real money ON => rounds stake + pay out in real USDC-backed `cash`; OFF => soft `coin`.
  const stakeAsset = env.REAL_MONEY_ENABLED ? ("cash" as const) : ("coin" as const);
  const rounds = makeRounds({ db, ledger, feed, stakeAsset, houseUserId });
  const sessionAuth = makeSessionAuth({
    users,
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
  const walletBinding = createWalletBinding({
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
  const depositIntents = makeDepositIntents({
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });

  const server = buildServer({
    users,
    ledger,
    inventory: makeInventory(db),
    rounds,
    feed,
    stakeAsset,
    devEndpoints: env.DEV_ENDPOINTS && env.NODE_ENV !== "production",
    signupFaucet: env.SIGNUP_FAUCET,
    startBalance: env.START_BALANCE,
    corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    devAuth: env.DEV_AUTH && env.NODE_ENV !== "production",
    sessionAuth,
    walletBinding,
    depositIntents,
    realMoney,
    depositTxBuilder,
    signedTxBroadcaster,
    walletBalanceReader,
    depositMinCents: env.DEPOSIT_MIN_CENTS,
    depositMaxCents: env.DEPOSIT_MAX_CENTS,
    withdrawals: withdrawalsSvc ?? null,
    withdrawProcessor: null,
    payoutSigner,
  });

  const addr = await server.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`perps server listening on ${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
