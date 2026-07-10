import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Users } from "../services/users.js";
import type { Ledger } from "../services/ledger.js";
import type { Inventory } from "../services/inventory.js";
import type { Rounds } from "../services/rounds.js";
import type { TradeHistory } from "../services/trade-history.js";
import type { PriceFeed } from "../feed/types.js";
import { FeedHaltError, RoundNotFoundError, RoundClosedError, OpenRoundExistsError } from "../services/errors.js";
import { makeRequireUser, makeRequireAdmin, makeRequireWalletBoundUser } from "./auth.js";

export interface RouteDeps {
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  rounds: Rounds;
  tradeHistory: TradeHistory;
  feed: PriceFeed;
  stakeAsset: "coin" | "cash"; // asset the wagering balance + rounds use ("cash" when real money is on)
  devEndpoints: boolean;
  signupFaucet: boolean;   // env-gated soft-coin seeding
  startBalance: number;    // coins to seed on first sight
  devAuth: boolean;
  sessionAuth: import("../auth/session.js").SessionAuth;
  walletBinding: import("../auth/wallet-binding.js").WalletBinding;
  depositIntents: import("../services/deposit-intents.js").DepositIntents;
  realMoney: { enabled: boolean; treasuryUsdcAta: string | null };
  depositTxBuilder: import("../services/deposit-tx.js").DepositTxBuilder | null;
  signedTxBroadcaster: import("../services/signed-tx-broadcaster.js").SignedTxBroadcaster | null;
  walletBalanceReader: import("../services/wallet-balance.js").WalletBalanceReader | null;
  depositMinCents: number;
  depositMaxCents: number;
  withdrawals: import("../services/withdrawals.js").Withdrawals | null;
  withdrawProcessor: import("../services/withdraw-worker.js").WithdrawProcessor | null;
  payoutSigner: import("../services/withdraw-worker.js").WithdrawSigner | null;
  /** operator secret guarding the admin withdrawal-approval endpoint; null disables that surface. */
  adminSecret: string | null;
  upgrades: import("../services/upgrades.js").Upgrades;
  /** not consumed by any Phase 1 route — the seam Phase 2's /authorize validates against */
  entitlements: import("../services/entitlements.js").Entitlements;
  earnLimit: import("../services/earn-limit.js").EarnLimit;
}

const GrantCoins = z.object({ amount: z.number().int().positive() });
const CoinDelta = z.object({ amount: z.number().int().positive().max(1_000_000_000), ref: z.string().min(1).max(200) });
const GrantCar = z.object({ carId: z.string().min(1) });
const CarRef = z.object({ carId: z.string().min(1) });
const RedeemAccess = z.object({ code: z.string().trim().min(1).max(24) });
const WalletBindChallengeBody = z.object({ wallet: z.string().min(32).max(44) });
const WalletBindBody = z.object({
  challenge: z.string().min(1),
  signatureBase58: z.string().min(1),
});
const DepositSendBody = z.object({
  depositIntent: z.string().min(1),
  signedTxBase64: z.string().min(1),
});
const MigrateBody = z.object({
  coins: z.number().int().min(0).max(1_000_000_000),
  scrap: z.number().int().min(0).max(1_000_000_000),
  // bound the per-car count AND the number of cars so a tiny payload can't drive unbounded
  // DB work (defense in depth — the endpoint now also requires a wallet-bound session).
  cars: z
    .record(z.string().min(1), z.number().int().positive().max(1000))
    .refine((c) => Object.keys(c).length <= 64, { message: "too_many_cars" }),
  levels: z
    .object({
      turbo: z.number().int().min(0).max(10),
      tank: z.number().int().min(0).max(10),
      suspension: z.number().int().min(0).max(10),
    })
    .partial()
    .optional(),
});

const TradeBody = z.object({
  id: z.string().uuid(),
  asset: z.enum(["BTC", "ETH", "SOL"]),
  dir: z.union([z.literal(1), z.literal(-1)]),
  lev: z.number().int().min(1).max(3000),
  stakeBase: z.number().int().positive().safe(),
  entryPrice: z.number().positive().finite(),
  exitPrice: z.number().positive().finite(),
  openedAt: z.string().datetime(),
  outcome: z.enum(["cashout", "cap", "liq", "time"]),
  payoutBase: z.number().int().min(0).safe(),
});

const TradeQuery = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const OpenRound = z.object({
  asset: z.enum(["BTC", "ETH", "SOL"]),
  dir: z.union([z.literal(1), z.literal(-1)]),
  lev: z.number().int().min(10).max(1000),
  stake: z.number().int().min(1).max(5000), // cents: 1¢ floor … $50.00 cap
});
const RoundActionBody = z
  .object({
    roundId: z.string().uuid(),
    actionId: z.string().min(1),
    kind: z.enum(["flip", "lever"]),
    dir: z.union([z.literal(1), z.literal(-1)]).optional(),
    lev: z.number().int().min(10).max(1000).optional(),
  })
  .refine((v) => (v.kind === "flip" ? v.dir !== undefined : v.lev !== undefined), { message: "flip needs dir; lever needs lev" });
const CloseRound = z.object({ roundId: z.string().uuid(), reason: z.enum(["cashout", "expire"]).default("cashout") });

export function registerRoutes(server: FastifyInstance, deps: RouteDeps): void {
  const requireUser = makeRequireUser({ users: deps.users, devAuth: deps.devAuth, sessionAuth: deps.sessionAuth });
  // economy-MUTATING endpoints require a wallet-bound (non-anonymous) session — see the preHandler.
  const requireWalletBoundUser = makeRequireWalletBoundUser({ users: deps.users, devAuth: deps.devAuth, sessionAuth: deps.sessionAuth });
  const requireAdmin = makeRequireAdmin(deps.adminSecret);

  server.post("/v1/session", async () => deps.sessionAuth.issueAnonymous());

  server.get("/v1/balance", { preHandler: requireUser }, async (req) => {
    return { balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
  });

  server.post("/v1/coins/earn", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    if (!(await deps.earnLimit.check(req.userId!, "earn", p.data.amount)))
      return reply.code(429).send({ error: "earn_rate_exceeded" });
    await deps.ledger.credit(req.userId!, "coin", p.data.amount, "earn", `${req.userId!}:${p.data.ref}`);
    return { coins: await deps.ledger.balance(req.userId!, "coin") };
  });

  server.post("/v1/coins/spend", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await deps.ledger.debit(req.userId!, "coin", p.data.amount, "spend", `${req.userId!}:${p.data.ref}`);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      throw e;
    }
    return { coins: await deps.ledger.balance(req.userId!, "coin") };
  });

  server.post("/v1/scrap/earn", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    if (!(await deps.earnLimit.check(req.userId!, "scrap_earn", p.data.amount)))
      return reply.code(429).send({ error: "earn_rate_exceeded" });
    await deps.ledger.credit(req.userId!, "scrap", p.data.amount, "scrap_earn", `${req.userId!}:${p.data.ref}`);
    return { scrap: await deps.ledger.balance(req.userId!, "scrap") };
  });

  server.post("/v1/scrap/spend", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await deps.ledger.debit(req.userId!, "scrap", p.data.amount, "scrap_spend", `${req.userId!}:${p.data.ref}`);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      throw e;
    }
    return { scrap: await deps.ledger.balance(req.userId!, "scrap") };
  });

  const BuyBody = z.object({ track: z.enum(["turbo", "tank", "suspension"]) });
  // Authoritative upgrade purchase: the server debits the escalating cost and increments the level
  // in one transaction — a client can neither fake a level nor get one free.
  server.post("/v1/upgrades/buy", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = BuyBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return await deps.upgrades.buy(req.userId!, p.data.track);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      if (e?.message === "max_level") return reply.code(409).send({ error: "max_level" });
      if (e?.message === "debit_replay") return reply.code(409).send({ error: "debit_replay" });
      throw e;
    }
  });

  server.get("/v1/inventory", { preHandler: requireUser }, async (req) => {
    const rows = await deps.inventory.list(req.userId!);
    return { cars: rows.map((r) => ({ carId: r.carId, count: r.count, acquiredAt: r.acquiredAt })) };
  });

  // First-login welcome crate — granted ONCE PER ACCOUNT (server-side, atomic + idempotent).
  // Returns { granted: true } only on the first-ever call for this user; every later call → false.
  server.post("/v1/welcome/claim", { preHandler: requireUser }, async (req) => deps.users.claimWelcome(req.userId!));

  // Redeem an access code — reward granted ONCE PER (account, code) (server-side, atomic + idempotent).
  // Returns { granted: true } only the first time this account redeems this specific code; every
  // later call (same account+code), and any concurrent racer, → false.
  server.post("/v1/access/redeem", { preHandler: requireUser }, async (req, reply) => {
    const p = RedeemAccess.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    return deps.users.redeemAccess(req.userId!, p.data.code);
  });

  server.post("/v1/inventory/grant", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CarRef.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.inventory.grant(req.userId!, p.data.carId);
    return { carId: p.data.carId, isNew: r.isNew, count: r.count };
  });

  server.post("/v1/inventory/melt", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CarRef.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.inventory.melt(req.userId!, p.data.carId);
    return { carId: p.data.carId, melted: r.melted, count: r.count };
  });

  // FIRST-BIND migration: seed a brand-new (empty) server account from the player's local save.
  // Refuses (and never sums) if the account already has any coins/scrap/cars — prevents a
  // returning player's local save from double-crediting a server balance that already moved.
  // Coins/scrap are ref-idempotent (namespaced `migrate:${userId}`); cars are NOT — a concurrent
  // or repeated first-bind on a still-empty account could double-grant cars. Accepted for now:
  // cars are soft, non-withdrawable state.
  server.post("/v1/migrate", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = MigrateBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const userId = req.userId!;
    const [coins, scrap, cars, levels] = await Promise.all([
      deps.ledger.balance(userId, "coin"),
      deps.ledger.balance(userId, "scrap"),
      deps.inventory.list(userId),
      deps.upgrades.get(userId),
    ]);
    // Levels count as state: an account with upgrades is not brand-new, and seeding over it could
    // LOWER a level (silently losing an upgrade the player already bought).
    if (coins > 0 || scrap > 0 || cars.length > 0 || levels.turbo > 0 || levels.tank > 0 || levels.suspension > 0) {
      return { seeded: false, reason: "account_not_empty" };
    }
    if (p.data.coins > 0) await deps.ledger.credit(userId, "coin", p.data.coins, "migrate_seed", `migrate:${userId}`);
    if (p.data.scrap > 0) await deps.ledger.credit(userId, "scrap", p.data.scrap, "scrap_migrate_seed", `migrate:${userId}`);
    for (const [carId, n] of Object.entries(p.data.cars)) {
      await deps.inventory.grant(userId, carId, n); // one counted write per car, not n writes
    }
    if (p.data.levels) await deps.upgrades.seed(userId, p.data.levels);
    return { seeded: true };
  });

  server.get("/v1/me", { preHandler: requireUser }, async (req) => {
    const userId = req.userId!;
    // soft-coin seeding: idempotent on (signup_faucet, userId) — safe to attempt every call
    if (deps.signupFaucet) {
      await deps.ledger.credit(userId, "coin", deps.startBalance, "signup_faucet", userId);
    }
    const [balance, coins, scrap, rows, openRoundId, access, levels] = await Promise.all([
      deps.ledger.balance(userId, deps.stakeAsset),
      deps.ledger.balance(userId, "coin"),
      deps.ledger.balance(userId, "scrap"),
      deps.inventory.list(userId),
      deps.rounds.getOpenRoundId(userId),
      deps.users.accessCodes(userId),
      deps.upgrades.get(userId),
    ]);
    return {
      userId,
      balance,
      coins,
      scrap,
      cars: rows.map((r) => ({ carId: r.carId, count: r.count, acquiredAt: r.acquiredAt })),
      openRoundId,
      access,
      levels,
    };
  });

  server.get("/v1/deposit/address", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.realMoney.enabled || !deps.realMoney.treasuryUsdcAta) {
      return reply.code(404).send({ error: "deposits_disabled" });
    }
    const user = await deps.users.get(req.userId!);
    return {
      treasuryUsdcAta: deps.realMoney.treasuryUsdcAta,
      boundWallet: user?.walletPublicKey ?? null,
      note: "send USDC from your bound wallet to treasuryUsdcAta; credited after on-chain finality",
    };
  });

  const DepositBuildBody = z.object({ amountCents: z.number().int().positive() });
  const buildDepositTx = async (req: any, reply: any) => {
    if (!deps.depositTxBuilder) return reply.code(404).send({ error: "deposits_disabled" });
    const body = DepositBuildBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < deps.depositMinCents || body.data.amountCents > deps.depositMaxCents) {
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    }
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const { txBase64 } = await deps.depositTxBuilder.buildForUser(user.walletPublicKey, body.data.amountCents);
    const intent = deps.depositIntents.create({
      userId: req.userId!,
      wallet: user.walletPublicKey,
      amountCents: body.data.amountCents,
      txBase64,
    });
    return { txBase64, depositIntent: intent.depositIntent, expiresAt: intent.expiresAt };
  };
  server.post("/v1/deposit/build", { preHandler: requireUser }, buildDepositTx);
  server.post("/v1/deposit/send", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.signedTxBroadcaster) return reply.code(404).send({ error: "deposit_send_disabled" });
    const body = DepositSendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const intent = deps.depositIntents.verify(body.data.depositIntent);
    if (!intent || intent.userId !== req.userId!) return reply.code(401).send({ error: "invalid_deposit_intent" });
    try {
      return await deps.signedTxBroadcaster.broadcastSignedDeposit({
        expectedTxBase64: intent.txBase64,
        signedTxBase64: body.data.signedTxBase64,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "signed_transaction_message_mismatch") {
        return reply.code(400).send({ error: "signed_transaction_message_mismatch" });
      }
      if (e instanceof Error && e.message === "signed_transaction_missing_existing_signature") {
        return reply.code(400).send({ error: "signed_transaction_missing_existing_signature" });
      }
      if (e instanceof Error && e.message === "signed_transaction_existing_signature_mismatch") {
        return reply.code(400).send({ error: "signed_transaction_existing_signature_mismatch" });
      }
      throw e;
    }
  });

  server.post("/v1/wallet/bind-challenge", { preHandler: requireUser }, async (req, reply) => {
    const body = WalletBindChallengeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return deps.walletBinding.createChallenge({
        userId: req.userId!,
        wallet: body.data.wallet,
      });
    } catch {
      return reply.code(400).send({ error: "invalid_wallet_address" });
    }
  });

  server.post("/v1/wallet/bind", { preHandler: requireUser }, async (req, reply) => {
    const body = WalletBindBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const verified = await deps.walletBinding.verifyChallenge(body.data);
    if (!verified || verified.userId !== req.userId!) {
      return reply.code(401).send({ error: "invalid_wallet_signature" });
    }
    try {
      const user = await deps.users.setWalletPublicKey(req.userId!, verified.wallet);
      return { wallet: user.walletPublicKey };
    } catch (e) {
      if (e instanceof Error && e.message === "wallet_already_bound") {
        const owner = await deps.users.getByWalletPublicKey(verified.wallet);
        if (!owner) return reply.code(409).send({ error: "wallet_already_bound" });
        const session = await deps.sessionAuth.issueForUser(owner.id);
        return { wallet: owner.walletPublicKey, ...session };
      }
      throw e;
    }
  });

  server.get("/v1/wallet/usdc-balance", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.walletBalanceReader) return reply.code(404).send({ error: "wallet_balance_disabled" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return { wallet: null, balance: 0 };
    try {
      return { wallet: user.walletPublicKey, balance: await deps.walletBalanceReader.balanceCents(user.walletPublicKey) };
    } catch (e) {
      req.log.warn({ err: e, wallet: user.walletPublicKey }, "wallet_balance_read_failed");
      return reply.code(503).send({ error: "wallet_balance_unavailable" });
    }
  });

  const WithdrawBody = z.object({ amountCents: z.number().int().positive() });
  server.post("/v1/withdraw", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.withdrawals) return reply.code(404).send({ error: "withdrawals_disabled" });
    // Fail closed: reserving DEBITS the user, so we must never reserve unless the full processing
    // path exists — a send worker (withdrawProcessor) AND an approval trigger (adminSecret). Without
    // both, an approved withdrawal can never be driven reserved→sent and the debited funds strand.
    if (!deps.withdrawProcessor || !deps.adminSecret) return reply.code(503).send({ error: "withdrawals_unavailable" });
    const body = WithdrawBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.withdrawals.reserve(req.userId!, body.data.amountCents);
    if (r.status !== "ok") return reply.code(409).send({ error: r.status });
    return { withdrawalId: r.withdrawalId, state: r.state };
  });

  // admin-authorized approval (v1 stand-in for the quorum/Intents co-signer): awaiting_approval →
  // signing → sent, exactly-once via the idempotency key inside approveAndSend. Guarded by the
  // shared admin secret (requireAdmin) so an operator can drive withdrawals in PRODUCTION — no
  // longer gated on devEndpoints (which is false in prod and left withdrawals stranded).
  server.post("/v1/admin/withdraw/:id/approve", { preHandler: requireAdmin }, async (req, reply) => {
    if (!deps.withdrawProcessor) return reply.code(404).send({ error: "not_found" });
    const id = (req.params as { id: string }).id;
    const r = await deps.withdrawProcessor.approveAndSend(id);
    if (r.status !== "sent") return reply.code(409).send({ error: r.status });
    return { status: "sent" };
  });

  server.post("/v1/trades", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const assertedWalletHeader = req.headers["x-trade-wallet"];
    const assertedWallet = Array.isArray(assertedWalletHeader) ? assertedWalletHeader[0] : assertedWalletHeader;
    if (assertedWallet !== undefined) {
      const user = await deps.users.get(req.userId!);
      if (user?.walletPublicKey !== assertedWallet) {
        return reply.code(409).send({ error: "trade_wallet_mismatch" });
      }
    }
    const parsed = TradeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return await deps.tradeHistory.record(req.userId!, {
        ...parsed.data,
        openedAt: new Date(parsed.data.openedAt),
      });
    } catch (error) {
      if ((error as Error).message === "trade_id_conflict") {
        return reply.code(409).send({ error: "trade_id_conflict" });
      }
      throw error;
    }
  });

  server.get("/v1/trades", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const parsed = TradeQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return await deps.tradeHistory.list(req.userId!, parsed.data.cursor, parsed.data.limit);
    } catch (error) {
      if ((error as Error).message === "bad_cursor") {
        return reply.code(400).send({ error: "bad_cursor" });
      }
      throw error;
    }
  });

  server.post("/v1/round/open", { preHandler: requireUser }, async (req, reply) => {
    const p = OpenRound.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.message });
    try {
      const r = await deps.rounds.open(req.userId!, p.data);
      return { roundId: r.id, asset: r.asset, dir: r.dir, lev: r.lev, stake: r.stake, entryRaw: r.entryRaw, entryTsUs: r.entryTsUs };
    } catch (e: any) {
      if (e instanceof FeedHaltError) return reply.code(503).send({ error: "feed_halt" });
      if (e instanceof OpenRoundExistsError) return reply.code(409).send({ error: "round_already_open" });
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      throw e;
    }
  });

  server.post("/v1/round/action", { preHandler: requireUser }, async (req, reply) => {
    const p = RoundActionBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.message });
    try {
      const { round, actions } = await deps.rounds.action(req.userId!, p.data.roundId, {
        actionId: p.data.actionId,
        kind: p.data.kind,
        dir: p.data.dir,
        lev: p.data.lev,
      });
      return { roundId: round.id, status: round.status, actionCount: actions.length };
    } catch (e: any) {
      if (e instanceof FeedHaltError) return reply.code(503).send({ error: "feed_halt" });
      if (e instanceof RoundNotFoundError) return reply.code(404).send({ error: "round_not_found" });
      if (e instanceof RoundClosedError) return reply.code(409).send({ error: "round_not_open" });
      throw e;
    }
  });

  server.post("/v1/round/close", { preHandler: requireUser }, async (req, reply) => {
    const p = CloseRound.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.message });
    try {
      const res = await deps.rounds.close(req.userId!, p.data.roundId, p.data.reason);
      // Settle responds INSTANTLY. The winning payout is already credited in-game by
      // rounds.close (round_payout), so the balance returned here includes it. Pushing it
      // on-chain to the player's wallet is slow, so we do
      // that in the BACKGROUND and let the client reconcile the wallet a moment later. If
      // the send ever fails the payout just stays in-game, safe and withdrawable, never lost.
      const balance = await deps.ledger.balance(req.userId!, deps.stakeAsset);
      if (deps.stakeAsset === "cash" && deps.payoutSigner && res.payoutCoins > 0) {
        const user = await deps.users.get(req.userId!);
        if (user?.walletPublicKey) {
          const userId = req.userId!;
          const destWallet = user.walletPublicKey;
          const payoutCoins = res.payoutCoins;
          const roundId = res.round.id;
          const signer = deps.payoutSigner;
          void (async () => {
            try {
              await signer.signAndSend({ destWallet, amountCents: payoutCoins, idempotencyKey: `round-payout:${roundId}` });
              // mirror the on-chain move in the ledger (idempotent on round id)
              await deps.ledger.post(userId, "cash", -payoutCoins, "round_payout_sent", roundId);
            } catch (err) {
              console.warn("[round_payout_send_failed]", { roundId, err: err instanceof Error ? err.message : String(err) });
            }
          })();
        }
      }
      return {
        outcome: res.outcome,
        payoutCoins: res.payoutCoins,
        pnlCoins: res.pnlCoins,
        equity: res.equity,
        exitRaw: res.round.exitRaw,
        payoutTxSig: null, // payout broadcasts in the background; client doesn't wait on it
        payoutProviderTxId: null,
        balance,
      };
    } catch (e: any) {
      if (e instanceof FeedHaltError) return reply.code(503).send({ error: "feed_halt" });
      if (e instanceof RoundNotFoundError) return reply.code(404).send({ error: "round_not_found" });
      throw e;
    }
  });

  server.get("/v1/round/:id", { preHandler: requireUser }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const round = await deps.rounds.get(req.userId!, id);
    if (!round) return reply.code(404).send({ error: "round_not_found" });
    return round;
  });

  // live "mark": current equity/payout from the server feed — what the client displays so the
  // shown × equals what it settles for. Read-only.
  server.get("/v1/round/:id/mark", { preHandler: requireUser }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      return await deps.rounds.mark(req.userId!, id);
    } catch (e: any) {
      if (e instanceof RoundNotFoundError) return reply.code(404).send({ error: "round_not_found" });
      throw e;
    }
  });

  if (deps.devEndpoints) {
    server.post("/v1/dev/grant-coins", { preHandler: requireUser }, async (req, reply) => {
      const parsed = GrantCoins.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      await deps.ledger.credit(req.userId!, "coin", parsed.data.amount, "dev_grant");
      return { balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
    });

    server.post("/v1/dev/grant-car", { preHandler: requireUser }, async (req, reply) => {
      const parsed = GrantCar.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const granted = await deps.inventory.grant(req.userId!, parsed.data.carId);
      const rows = await deps.inventory.list(req.userId!);
      return { granted, cars: rows.map((r) => r.carId) };
    });
  }
}
