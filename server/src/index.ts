import { env } from "./env.js";
import { createRuntimeDb } from "./db/runtime.js";
import { buildServer } from "./http/server.js";
import { makeUsers } from "./services/users.js";
import { makeLedger } from "./services/ledger.js";
import { makeInventory } from "./services/inventory.js";
import { makeRounds } from "./services/rounds.js";
import { makeUpgrades } from "./services/upgrades.js";
import { makeCrateOpen } from "./services/crate-open.js";
import { makeEntitlements } from "./services/entitlements.js";
import { makeEarnLimit } from "./services/earn-limit.js";
import { makeTradeHistory } from "./services/trade-history.js";
import { assertRoundSettlerForStake, type RoundSettler } from "./services/round-settler-guard.js";
import { makeRoundSettler } from "./services/round-settler.js";
import { ensureHouseUserId } from "./services/house.js";
import { makeHermesFeed } from "./feed/hermes.js";
import { feedAssetKeys } from "./feed/symbols.js";
import { makeSessionAuth } from "./auth/session.js";
import { createWalletBinding } from "./auth/wallet-binding.js";
import { makeDepositTxBuilder, makeRpcBlockhash, type DepositTxBuilder } from "./services/deposit-tx.js";
import { makeDepositIntents } from "./services/deposit-intents.js";
import type { WithdrawSigner } from "./services/withdraw-worker.js";
import { eq } from "drizzle-orm";
import { withdrawals, rounds as roundsTable } from "./db/schema.js";
import { makePresenceRoom } from "./presence/room.js";
import { makeHighwayIndexer, makeRpcHighwayRoundReader } from "./presence/highway-indexer.js";

async function main(): Promise<void> {
  // fail loud: dev seed endpoints must never be enabled in production
  if (env.DEV_ENDPOINTS && env.NODE_ENV === "production")
    throw new Error("refusing to boot: DEV_ENDPOINTS must not be enabled in production");

  // Real money ON => rounds stake + pay out in real USDC-backed `cash`; OFF => soft `coin`.
  // The autonomous settler cash requires is constructed below, once `rounds` exists — it has to
  // share that exact instance — and assertRoundSettlerForStake runs there.
  const stakeAsset = env.REAL_MONEY_ENABLED ? ("cash" as const) : ("coin" as const);

  const raw = createRuntimeDb({
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV,
    realMoneyEnabled: env.REAL_MONEY_ENABLED,
  });
  // Auto-migrate is a DEV convenience only. In production, migrations run as an
  // explicit pre-deploy release step (`npm run db:migrate`) — never silently
  // mutate the money tables at app boot. See migrate.ts + the Railway release command.
  if (env.NODE_ENV !== "production") await raw.runMigrations();
  const db = raw.db;

  const ledger = makeLedger(db);
  const users = makeUsers(db);
  const tradeHistory = makeTradeHistory({ db, users });
  // the house counterparty round P&L flows to/from (provisioned once, idempotent).
  const houseUserId = await ensureHouseUserId(users);

  let depositConfirmer: { start(): void; stop(): void } | undefined;
  let realMoney = { enabled: false, treasuryUsdcAta: null as string | null };
  let depositTxBuilder: DepositTxBuilder | null = null;
  let walletBalanceReader: import("./services/wallet-balance.js").WalletBalanceReader | null = null;
  let signedTxBroadcaster: import("./services/signed-tx-broadcaster.js").SignedTxBroadcaster | null = null;
  let withdrawalsSvc: import("./services/withdrawals.js").Withdrawals | undefined;
  let payoutSigner: WithdrawSigner | null = null;
  let withdrawProcessor: import("./services/withdraw-worker.js").WithdrawProcessor | null = null;
  if (env.REAL_MONEY_ENABLED) {
    // Both rails assign the SAME locals above, so buildServer never learns which chain is live.
    // Solana-only legs (fee sponsorship, the server-built deposit tx, the signed-tx broadcaster) stay
    // null on EVM — see the EVM branch.
    if (env.CHAIN_FAMILY === "solana") {
      const { makeRpcDepositSource } = await import("./solana/deposit-source.js");
      const { assertUsdcMint } = await import("./solana/mint-assert.js");
      const { makeDeposits } = await import("./services/deposits.js");
      const { makeDepositConfirmer, makeDbDepositCursorStore } = await import("./services/deposit-worker.js");
      const { makeRpcWalletBalanceReader } = await import("./services/wallet-balance.js");
      const { makeRpcSignedTxBroadcaster } = await import("./services/signed-tx-broadcaster.js");
      const source = makeRpcDepositSource(env.SOLANA_RPC_URL!);
      await assertUsdcMint((m) => source.fetchMintInfo(m), env.USDC_MINT!); // refuse to boot on a bad mint
      const deposits = makeDeposits(db, ledger, {
        usdcMint: env.USDC_MINT!, treasuryAta: env.TREASURY_USDC_ATA!,
        minCents: env.DEPOSIT_MIN_CENTS, maxCents: env.DEPOSIT_MAX_CENTS,
      });
      if (env.RUN_CONFIRMER) {
        depositConfirmer = makeDepositConfirmer({ deposits, source, store: makeDbDepositCursorStore(db), treasuryAta: env.TREASURY_USDC_ATA!, pollMs: env.DEPOSIT_POLL_MS });
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
        if (env.FEE_PAYER_OWNER_PUBKEY === env.TREASURY_OWNER_PUBKEY) {
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
      // Self-custody send-leg: enabled only when a treasury keypair secret is configured.
      // Unset => withdrawProcessor stays null and the admin-approve endpoint 404s (unchanged).
      if (env.TREASURY_SECRET) {
        const { makeTreasuryWithdrawSigner } = await import("./solana/treasury-signer.js");
        const treasurySigner = await makeTreasuryWithdrawSigner(env.TREASURY_SECRET, {
          rpcUrl: env.SOLANA_RPC_URL!,
          treasuryUsdcAta: env.TREASURY_USDC_ATA!,
          usdcMint: env.USDC_MINT!,
          getLatestBlockhash: makeRpcBlockhash(env.SOLANA_RPC_URL!),
        });
        if (treasurySigner.address !== env.TREASURY_OWNER_PUBKEY) {
          throw new Error("TREASURY_OWNER_PUBKEY does not match TREASURY_SECRET");
        }
        const { makeWithdrawProcessor, makeWithdrawConfirmer } = await import("./services/withdraw-worker.js");
        withdrawProcessor = makeWithdrawProcessor(db, treasurySigner);

        if (env.RUN_CONFIRMER) {
          const { makeRpcChainStatusReader } = await import("./solana/chain-status.js");
          const { makeWithdrawConfirmLoop } = await import("./services/withdraw-confirm-loop.js");
          const confirmer = makeWithdrawConfirmer(db, ledger, makeRpcChainStatusReader(env.SOLANA_RPC_URL!));
          const loop = makeWithdrawConfirmLoop({
            confirmer,
            pollMs: env.WITHDRAW_POLL_MS,
            listSentIds: async () =>
              (await db.select({ id: withdrawals.id }).from(withdrawals).where(eq(withdrawals.status, "sent"))).map(
                (r: { id: string }) => r.id,
              ),
          });
          loop.start();
        }
      }
    }

    if (env.CHAIN_FAMILY === "evm") {
      const { bootEvmRail } = await import("./evm/boot.js");
      const { makeDbDepositCursorStore } = await import("./services/deposit-worker.js");
      // Throws on any misconfiguration (wrong token decimals, a treasury secret that is not the
      // treasury's), so a bad EVM config never reaches a listening server.
      const rail = await bootEvmRail(env, { db, ledger });

      if (env.RUN_CONFIRMER) {
        depositConfirmer = rail.makeConfirmer(makeDbDepositCursorStore(db));
        depositConfirmer.start();
      }
      // /v1/deposit/address serves this verbatim: on EVM the deposit destination is the treasury EOA
      // itself (no ATA to derive), and the client sends its own ERC-20 transfer to it.
      realMoney = { enabled: true, treasuryUsdcAta: rail.treasury };
      // depositTxBuilder / signedTxBroadcaster stay null: there is no server-built deposit tx on this
      // rail, so /v1/deposit/build and /v1/deposit/send 404 exactly as they do with the legs unset.
      walletBalanceReader = { balanceCents: (wallet) => rail.walletUsdcCents(wallet) };

      const { makeWithdrawals } = await import("./services/withdrawals.js");
      withdrawalsSvc = makeWithdrawals(db, ledger, {
        minCents: env.WITHDRAW_MIN_CENTS, maxCents: env.WITHDRAW_MAX_CENTS,
        userDailyCapCents: env.WITHDRAW_USER_DAILY_CAP_CENTS, globalDailyCapCents: env.WITHDRAW_GLOBAL_DAILY_CAP_CENTS,
        holdHours: env.WITHDRAW_HOLD_HOURS, quorumThresholdCents: env.WITHDRAW_QUORUM_THRESHOLD_CENTS,
      }, rail.readTreasuryBaseUnits);

      // Same rule as Solana: no treasury secret => withdrawProcessor stays null and the
      // admin-approve endpoint 404s, so nothing can be sent.
      if (rail.treasurySigner) {
        const { makeWithdrawProcessor, makeWithdrawConfirmer } = await import("./services/withdraw-worker.js");
        withdrawProcessor = makeWithdrawProcessor(db, rail.treasurySigner);

        if (env.RUN_CONFIRMER) {
          const { makeWithdrawConfirmLoop } = await import("./services/withdraw-confirm-loop.js");
          // 600s, well above the 180s Solana default: an EVM tx has no blockhash expiry, so a
          // still-unconfirmed send is usually a low-fee tx waiting in the mempool, not a dropped one.
          // Escalating on the Solana window would flag healthy withdrawals for manual review.
          const confirmer = makeWithdrawConfirmer(db, ledger, rail.chainStatus, { staleSeconds: 600 });
          const loop = makeWithdrawConfirmLoop({
            confirmer,
            pollMs: env.WITHDRAW_POLL_MS,
            listSentIds: async () =>
              (await db.select({ id: withdrawals.id }).from(withdrawals).where(eq(withdrawals.status, "sent"))).map(
                (r: { id: string }) => r.id,
              ),
          });
          loop.start();
        }
      }
    }
  }
  // poll rate + HALT tolerance are tunable: the public Hermes REST endpoint can
  // rate-limit a tight 500ms poll, so a too-small stale window flaps into feed_halt.
  const feed = makeHermesFeed({
    assets: feedAssetKeys(),
    pollMs: Number(process.env.FEED_POLL_MS) || undefined,
    staleMs: Number(process.env.FEED_STALE_MS) || undefined,
    accessToken: env.PYTH_API_KEY,
  });
  feed.start();
  const rounds = makeRounds({ db, ledger, feed, stakeAsset, houseUserId });

  // Autonomous cash settler. It MUST be given the same `rounds` instance the routes below get:
  // mark() primes the per-instance shown-mark cache that close() settles against, so a second
  // instance would settle at a different price than the one the sweep just evaluated.
  // Coin rounds never need it (nothing real is at stake), so it stays null there.
  const roundSettler: RoundSettler | null =
    stakeAsset === "cash"
      ? makeRoundSettler({
          rounds,
          listOpen: async () =>
            await db
              .select({ id: roundsTable.id, userId: roundsTable.userId })
              .from(roundsTable)
              .where(eq(roundsTable.status, "open")),
          pollMs: env.ROUND_SETTLE_POLL_MS,
          // roundId is "" when listOpen itself failed (nothing was swept this tick).
          onError: (id, e) => console.warn("[round_settle_failed]", id, e),
        })
      : null;
  assertRoundSettlerForStake({ stakeAsset, cashSettlerEnabled: env.CASH_SETTLER_ENABLED, roundSettler });
  roundSettler?.start();

  const sessionAuth = makeSessionAuth({
    users,
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
  const walletBinding = createWalletBinding({
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
    family: env.CHAIN_FAMILY,
  });
  const depositIntents = makeDepositIntents({
    secret: env.SESSION_SECRET ?? "development-session-secret-change-before-production",
  });
  const inventory = makeInventory(db);
  const upgrades = makeUpgrades(db, ledger);
  const crateOpen = makeCrateOpen(ledger, inventory, users);
  const entitlements = makeEntitlements({ inventory, upgrades }); // consumed by Phase 2's /authorize; wired now as the seam
  const earnLimit = makeEarnLimit(db, { ceiling: env.EARN_WINDOW_CEILING, windowMs: env.EARN_WINDOW_MS });
  const presenceRoom = makePresenceRoom();
  if (env.HIGHWAY_INDEXER_ENABLED) {
    const highwayIndexer = makeHighwayIndexer({
      read: makeRpcHighwayRoundReader(env.HIGHWAY_INDEXER_RPC),
      publish: (positions) => presenceRoom.setIndexedHighways(positions),
      pollMs: env.HIGHWAY_INDEXER_POLL_MS,
      onError: (error) => console.warn("[highway_index_refresh_failed]", error),
    });
    try {
      await highwayIndexer.refresh();
    } catch (error) {
      console.warn("[highway_index_initial_refresh_failed]", error);
    }
    highwayIndexer.start();
  }

  const server = buildServer({
    users,
    ledger,
    inventory,
    rounds,
    tradeHistory,
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
    withdrawProcessor,
    payoutSigner,
    adminSecret: env.ADMIN_API_SECRET ?? null,
    upgrades,
    crateOpen,
    entitlements,
    earnLimit,
    presenceRoom,
  });

  const addr = await server.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`perps server listening on ${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
