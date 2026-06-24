import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Users } from "../services/users.js";
import type { Ledger } from "../services/ledger.js";
import type { Inventory } from "../services/inventory.js";
import type { Rounds } from "../services/rounds.js";
import type { PriceFeed } from "../feed/types.js";
import { FeedHaltError, RoundNotFoundError, RoundClosedError, OpenRoundExistsError } from "../services/errors.js";
import { makeRequireUser } from "./auth.js";

export interface RouteDeps {
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  rounds: Rounds;
  feed: PriceFeed;
  stakeAsset: "coin" | "cash"; // asset the wagering balance + rounds use ("cash" when real money is on)
  devEndpoints: boolean;
  signupFaucet: boolean;   // env-gated soft-coin seeding
  startBalance: number;    // coins to seed on first sight
  devAuth: boolean;
  privyAuth: import("../auth/privy.js").PrivyAuth | null;
  realMoney: { enabled: boolean; treasuryUsdcAta: string | null };
  depositTxBuilder: import("../services/deposit-tx.js").DepositTxBuilder | null;
  playPaymentConfirmer: import("../services/play-payments.js").PlayPaymentConfirmer | null;
  walletBalanceReader: import("../services/wallet-balance.js").WalletBalanceReader | null;
  depositMinCents: number;
  depositMaxCents: number;
  withdrawals: import("../services/withdrawals.js").Withdrawals | null;
  withdrawProcessor: import("../services/withdraw-worker.js").WithdrawProcessor | null;
  payoutSigner: import("../solana/withdraw-signer.js").WithdrawSigner | null;
}

const GrantCoins = z.object({ amount: z.number().int().positive() });
const GrantCar = z.object({ carId: z.string().min(1) });

const OpenRound = z.object({
  asset: z.enum(["BTC", "ETH", "SOL"]),
  dir: z.union([z.literal(1), z.literal(-1)]),
  lev: z.number().int().min(10).max(1000),
  stake: z.number().int().min(1).max(5000), // cents: 1¢ floor … $50.00 cap
});
const PLAY_PAYMENT_MIN_CENTS = 1;
const PLAY_PAYMENT_MAX_CENTS = 5000;
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
  const requireUser = makeRequireUser({ users: deps.users, devAuth: deps.devAuth, privyAuth: deps.privyAuth });

  server.get("/v1/balance", { preHandler: requireUser }, async (req) => {
    return { balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
  });

  server.get("/v1/inventory", { preHandler: requireUser }, async (req) => {
    const rows = await deps.inventory.list(req.userId!);
    return { cars: rows.map((r) => ({ carId: r.carId, acquiredAt: r.acquiredAt })) };
  });

  server.get("/v1/me", { preHandler: requireUser }, async (req) => {
    const userId = req.userId!;
    // soft-coin seeding: idempotent on (signup_faucet, userId) — safe to attempt every call
    if (deps.signupFaucet) {
      await deps.ledger.credit(userId, "coin", deps.startBalance, "signup_faucet", userId);
    }
    const [balance, rows, openRoundId] = await Promise.all([
      deps.ledger.balance(userId, deps.stakeAsset),
      deps.inventory.list(userId),
      deps.rounds.getOpenRoundId(userId),
    ]);
    return {
      userId,
      balance,
      cars: rows.map((r) => ({ carId: r.carId, acquiredAt: r.acquiredAt })),
      openRoundId,
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
  const PlayPaymentConfirmBody = z.object({ txSig: z.string().min(1) });
  const buildUserToVaultTx = async (req: any, reply: any, disabledError: string, minCents: number, maxCents: number) => {
    if (!deps.depositTxBuilder) return reply.code(404).send({ error: disabledError });
    const body = DepositBuildBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < minCents || body.data.amountCents > maxCents)
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const { txBase64 } = await deps.depositTxBuilder.buildForUser(user.walletPublicKey, body.data.amountCents);
    return { txBase64 };
  };
  server.post("/v1/deposit/build", { preHandler: requireUser }, async (req, reply) => {
    return buildUserToVaultTx(req, reply, "deposits_disabled", deps.depositMinCents, deps.depositMaxCents);
  });

  server.post("/v1/play/payment/build", { preHandler: requireUser }, async (req, reply) => {
    return buildUserToVaultTx(req, reply, "play_payments_disabled", PLAY_PAYMENT_MIN_CENTS, PLAY_PAYMENT_MAX_CENTS);
  });

  server.post("/v1/play/payment/confirm", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentConfirmer) return reply.code(404).send({ error: "play_payment_confirm_disabled" });
    const body = PlayPaymentConfirmBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const out = await deps.playPaymentConfirmer.confirm(body.data.txSig);
    return { ...out, balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
  });

  server.get("/v1/wallet/usdc-balance", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.walletBalanceReader) return reply.code(404).send({ error: "wallet_balance_disabled" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return { wallet: null, balance: 0 };
    return { wallet: user.walletPublicKey, balance: await deps.walletBalanceReader.balanceCents(user.walletPublicKey) };
  });

  const WithdrawBody = z.object({ amountCents: z.number().int().positive() });
  server.post("/v1/withdraw", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.withdrawals) return reply.code(404).send({ error: "withdrawals_disabled" });
    const body = WithdrawBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.withdrawals.reserve(req.userId!, body.data.amountCents);
    if (r.status !== "ok") return reply.code(409).send({ error: r.status });
    return { withdrawalId: r.withdrawalId, state: r.state };
  });

  // admin-gated approval (v1 stand-in for the quorum/Intents co-signer). NEVER exposed in prod
  // (gated on devEndpoints, which is false in production).
  server.post("/v1/admin/withdraw/:id/approve", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.devEndpoints || !deps.withdrawProcessor) return reply.code(404).send({ error: "not_found" });
    const id = (req.params as { id: string }).id;
    const r = await deps.withdrawProcessor.approveAndSend(id);
    if (r.status !== "sent") return reply.code(409).send({ error: r.status });
    return { status: "sent" };
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
      let payoutTxSig: string | null = null;
      let payoutPrivyTxId: string | null = null;
      if (deps.stakeAsset === "cash" && deps.payoutSigner && res.payoutCoins > 0) {
        const user = await deps.users.get(req.userId!);
        if (user?.walletPublicKey) {
          const sent = await deps.payoutSigner.signAndSend({
            destWallet: user.walletPublicKey,
            amountCents: res.payoutCoins,
            idempotencyKey: `round-payout:${res.round.id}`,
          });
          payoutTxSig = sent.txSig;
          payoutPrivyTxId = sent.privyTxId;
          await deps.ledger.post(req.userId!, "cash", -res.payoutCoins, "round_payout_sent", res.round.id);
        }
      }
      return {
        outcome: res.outcome,
        payoutCoins: res.payoutCoins,
        pnlCoins: res.pnlCoins,
        equity: res.equity,
        exitRaw: res.round.exitRaw,
        payoutTxSig,
        payoutPrivyTxId,
        balance: await deps.ledger.balance(req.userId!, deps.stakeAsset),
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
