import { env } from "./env.js";
import { createDb } from "./db/client.js";
import { buildServer } from "./http/server.js";
import { makeUsers } from "./services/users.js";
import { makeLedger } from "./services/ledger.js";
import { makeInventory } from "./services/inventory.js";
import { makeRounds } from "./services/rounds.js";
import { makeHermesFeed } from "./feed/hermes.js";
import { makePrivyAuth } from "./auth/privy.js";

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

  let depositConfirmer: { start(): void; stop(): void } | undefined;
  let realMoney = { enabled: false, treasuryUsdcAta: null as string | null };
  let withdrawalsSvc: import("./services/withdrawals.js").Withdrawals | undefined;
  if (env.REAL_MONEY_ENABLED) {
    const { makeRpcDepositSource } = await import("./solana/deposit-source.js");
    const { assertUsdcMint } = await import("./solana/mint-assert.js");
    const { makeDeposits } = await import("./services/deposits.js");
    const { makeDepositConfirmer } = await import("./services/deposit-worker.js");
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

    const { makeWithdrawals } = await import("./services/withdrawals.js");
    withdrawalsSvc = makeWithdrawals(db, ledger, {
      minCents: env.WITHDRAW_MIN_CENTS, maxCents: env.WITHDRAW_MAX_CENTS,
      userDailyCapCents: env.WITHDRAW_USER_DAILY_CAP_CENTS, globalDailyCapCents: env.WITHDRAW_GLOBAL_DAILY_CAP_CENTS,
      holdHours: env.WITHDRAW_HOLD_HOURS, quorumThresholdCents: env.WITHDRAW_QUORUM_THRESHOLD_CENTS,
    }, () => source.readTreasuryBaseUnits(env.TREASURY_USDC_ATA!));
    // withdrawProcessor stays null until the Privy signer is enabled post-Phase-0-staging
    // (needs treasury wallet id + caip2 config). The admin-approve endpoint 404s until then.
  }
  // poll rate + HALT tolerance are tunable: the public Hermes REST endpoint can
  // rate-limit a tight 500ms poll, so a too-small stale window flaps into feed_halt.
  const feed = makeHermesFeed({
    assets: ["BTC", "ETH", "SOL"],
    pollMs: Number(process.env.FEED_POLL_MS) || undefined,
    staleMs: Number(process.env.FEED_STALE_MS) || undefined,
  });
  feed.start();
  const rounds = makeRounds({ db, ledger, feed });
  const privyAuth = makePrivyAuth(env);
  // fail loud: production must verify real users — never boot with auth disabled
  if (env.NODE_ENV === "production" && !privyAuth)
    throw new Error(
      "FATAL: production requires Privy keys (PRIVY_APP_ID/PRIVY_APP_SECRET) — refusing to start with auth disabled",
    );

  const server = buildServer({
    users: makeUsers(db),
    ledger,
    inventory: makeInventory(db),
    rounds,
    feed,
    devEndpoints: env.DEV_ENDPOINTS && env.NODE_ENV !== "production",
    signupFaucet: env.SIGNUP_FAUCET,
    startBalance: env.START_BALANCE,
    corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    devAuth: env.DEV_AUTH && env.NODE_ENV !== "production",
    privyAuth,
    realMoney,
    withdrawals: withdrawalsSvc ?? null,
    withdrawProcessor: null,
  });

  const addr = await server.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`perps server listening on ${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
