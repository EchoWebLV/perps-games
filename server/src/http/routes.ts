import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Users } from "../services/users.js";
import type { Ledger } from "../services/ledger.js";
import type { Inventory } from "../services/inventory.js";
import type { Rounds } from "../services/rounds.js";
import type { PriceFeed } from "../feed/types.js";
import { FeedHaltError, RoundNotFoundError, RoundClosedError, OpenRoundExistsError } from "../services/errors.js";
import { PLAY_PAYMENT_MAX_CENTS, PLAY_PAYMENT_MIN_CENTS, type PlayPaymentConfirmResult } from "../services/play-payments.js";
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
  playPaymentBroadcaster: import("../services/play-payment-broadcaster.js").PlayPaymentBroadcaster | null;
  playPaymentCharger: import("../services/play-payment-charger.js").PlayPaymentCharger | null;
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

  function playPaymentRefundRef(txSigs: string[]): string {
    const basis = txSigs.length > 0 ? txSigs.slice().sort().join("|") : "missing-sigs";
    const digest = createHash("sha256").update(basis).digest("hex");
    return `play-payment-refund:${digest}`;
  }

  async function refundExcessPlayPayment(
    userId: string,
    destWallet: string,
    out: PlayPaymentConfirmResult,
    intendedAmountCents: number,
  ): Promise<PlayPaymentConfirmResult & {
    recoveredCents?: number;
    refundedCents?: number;
    refundTxSig?: string;
    refundPrivyTxId?: string | null;
  }> {
    if (out.status !== "credited" || out.amountCents <= intendedAmountCents) return out;
    const excessCents = out.amountCents - intendedAmountCents;
    if (!deps.payoutSigner) return out;

    const ref = playPaymentRefundRef(out.txSigs);
    const sent = await deps.payoutSigner.signAndSend({
      destWallet,
      amountCents: excessCents,
      idempotencyKey: ref,
    });
    await deps.ledger.post(userId, "cash", -excessCents, "play_payment_refund_sent", ref);
    return {
      ...out,
      amountCents: intendedAmountCents,
      recoveredCents: out.amountCents,
      refundedCents: excessCents,
      refundTxSig: sent.txSig,
      refundPrivyTxId: sent.privyTxId,
    };
  }

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
  const PlayPaymentSendBody = z.object({ signedTxBase64: z.string().min(1) });
  const PlayPaymentChargeBody = z.object({
    amountCents: z.number().int().positive(),
    attemptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  });
  const PlayPaymentPrepareBody = z.object({
    amountCents: z.number().int().positive(),
    attemptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  });
  const PlayPaymentAuthorizedChargeBody = z.object({
    chargeId: z.string().uuid(),
    signature: z.string().min(1),
  });
  const PlayPaymentConfirmBody = z.object({ txSig: z.string().min(1) });
  const PlayPaymentRecoverBody = z.object({ amountCents: z.number().int().positive() });
  const buildUserToVaultTx = async (
    req: any,
    reply: any,
    disabledError: string,
    minCents: number,
    maxCents: number,
    opts?: { feePayer?: "treasury" | "user" },
  ) => {
    if (!deps.depositTxBuilder) return reply.code(404).send({ error: disabledError });
    const body = DepositBuildBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < minCents || body.data.amountCents > maxCents)
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const { txBase64 } = await deps.depositTxBuilder.buildForUser(user.walletPublicKey, body.data.amountCents, opts);
    return { txBase64 };
  };
  server.post("/v1/deposit/build", { preHandler: requireUser }, async (req, reply) => {
    return buildUserToVaultTx(req, reply, "deposits_disabled", deps.depositMinCents, deps.depositMaxCents);
  });

  server.post("/v1/play/payment/build", { preHandler: requireUser }, async (req, reply) => {
    return buildUserToVaultTx(req, reply, "play_payments_disabled", PLAY_PAYMENT_MIN_CENTS, PLAY_PAYMENT_MAX_CENTS, {
      feePayer: "user",
    });
  });

  server.post("/v1/play/payment/send", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentBroadcaster) return reply.code(404).send({ error: "play_payment_send_disabled" });
    const body = PlayPaymentSendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return deps.playPaymentBroadcaster.broadcast(body.data.signedTxBase64);
  });

  function mapPlayPaymentChargeError(e: unknown, reply: any) {
    if (e instanceof Error && e.message === "privy_user_wallet_id_missing") {
      return reply.code(409).send({ error: "privy_user_wallet_id_missing" });
    }
    if (e instanceof Error && (
      e.message === "play_payment_charge_not_prepared" ||
      e.message === "play_payment_charge_wallet_mismatch"
    )) {
      return reply.code(409).send({ error: e.message });
    }
    if (e instanceof Error && e.message.startsWith("play_payment_charge_") && e.message.endsWith("_timeout")) {
      console.warn("[play_payment_charge_timeout]", { error: e.message });
      return reply.code(504).send({ error: e.message });
    }
    if (e instanceof Error && (
      e.message === "privy_user_wallet_sign_failed" ||
      e.message === "privy_user_wallet_sign_missing_signed_transaction" ||
      e.message === "privy_play_signer_required"
    )) {
      console.warn("[play_payment_charge_sign_failed]", { error: e.message, cause: e.cause instanceof Error ? e.cause.message : e.cause });
      return reply.code(502).send({ error: e.message });
    }
    throw e;
  }

  server.get("/v1/play/payment/signer", { preHandler: requireUser }, async (_req, reply) => {
    if (!deps.playPaymentCharger) return reply.code(404).send({ error: "play_payment_charge_disabled" });
    const signer = deps.playPaymentCharger.signer();
    if (!signer) return reply.code(404).send({ error: "play_payment_signer_disabled" });
    return { signers: [signer] };
  });

  server.post("/v1/play/payment/prepare", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentCharger) return reply.code(404).send({ error: "play_payment_charge_disabled" });
    const body = PlayPaymentPrepareBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < PLAY_PAYMENT_MIN_CENTS || body.data.amountCents > PLAY_PAYMENT_MAX_CENTS) {
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    }
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    try {
      return await deps.playPaymentCharger.prepare({
        userWallet: user.walletPublicKey,
        amountCents: body.data.amountCents,
        idempotencyKey: `play-payment:${req.userId!}:${body.data.attemptId}`,
      });
    } catch (e) {
      return mapPlayPaymentChargeError(e, reply);
    }
  });

  server.post("/v1/play/payment/charge-authorized", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentCharger) return reply.code(404).send({ error: "play_payment_charge_disabled" });
    const body = PlayPaymentAuthorizedChargeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    try {
      const charged = await deps.playPaymentCharger.chargeAuthorized({
        userWallet: user.walletPublicKey,
        chargeId: body.data.chargeId,
        signature: body.data.signature,
      });
      return { status: "sent" as const, txSig: charged.txSig };
    } catch (e) {
      return mapPlayPaymentChargeError(e, reply);
    }
  });

  server.post("/v1/play/payment/charge", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentCharger) return reply.code(404).send({ error: "play_payment_charge_disabled" });
    const body = PlayPaymentChargeBody.safeParse(req.body);
    if (!body.success) {
      console.warn("[play_payment_charge_bad_request]", { body: req.body, issues: body.error.issues });
      return reply.code(400).send({ error: "bad_request" });
    }
    if (body.data.amountCents < PLAY_PAYMENT_MIN_CENTS || body.data.amountCents > PLAY_PAYMENT_MAX_CENTS) {
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    }
    const userJwt = req.privyAccessToken;
    if (!userJwt) return reply.code(409).send({ error: "privy_token_required" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const started = Date.now();
    console.info("[play_payment_charge_start]", { userId: req.userId, amountCents: body.data.amountCents, hasAttemptId: !!body.data.attemptId });
    try {
      const charged = await deps.playPaymentCharger.charge({
        userWallet: user.walletPublicKey,
        amountCents: body.data.amountCents,
        userJwt,
        idempotencyKey: `play-payment:${req.userId!}:${body.data.attemptId ?? randomUUID()}`,
      });
      console.info("[play_payment_charge_sent]", { userId: req.userId, txSig: charged.txSig, elapsedMs: Date.now() - started });
      return { status: "sent" as const, txSig: charged.txSig };
    } catch (e) {
      return mapPlayPaymentChargeError(e, reply);
    }
  });

  server.post("/v1/play/payment/confirm", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentConfirmer) return reply.code(404).send({ error: "play_payment_confirm_disabled" });
    const body = PlayPaymentConfirmBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const confirmed = await deps.playPaymentConfirmer.confirm({
      txSig: body.data.txSig,
      userId: req.userId!,
      sourceOwner: user.walletPublicKey,
    });
    const out = await refundExcessPlayPayment(
      req.userId!,
      user.walletPublicKey,
      confirmed,
      confirmed.status === "credited" ? confirmed.paymentCents : 0,
    );
    return { ...out, balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
  });

  server.post("/v1/play/payment/recover", { preHandler: requireUser }, async (req, reply) => {
    if (!deps.playPaymentConfirmer) return reply.code(404).send({ error: "play_payment_recover_disabled" });
    const body = PlayPaymentRecoverBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.amountCents < PLAY_PAYMENT_MIN_CENTS || body.data.amountCents > PLAY_PAYMENT_MAX_CENTS) {
      return reply.code(400).send({ error: "amount_out_of_bounds" });
    }
    const user = await deps.users.get(req.userId!);
    if (!user?.walletPublicKey) return reply.code(409).send({ error: "no_bound_wallet" });
    const recovered = await deps.playPaymentConfirmer.recover({
      userId: req.userId!,
      sourceOwner: user.walletPublicKey,
      amountCents: body.data.amountCents,
    });
    const out = await refundExcessPlayPayment(req.userId!, user.walletPublicKey, recovered, body.data.amountCents);
    return { ...out, balance: await deps.ledger.balance(req.userId!, deps.stakeAsset) };
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
      // Settle responds INSTANTLY. The winning payout is already credited in-game by
      // rounds.close (round_payout), so the balance returned here includes it. Pushing it
      // on-chain to the player's wallet is slow (Privy sign + Solana broadcast), so we do
      // that in the BACKGROUND and let the client reconcile the wallet a moment later. If
      // the send ever fails the payout just stays in-game — safe and withdrawable, never lost.
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
        payoutTxSig: null,       // payout broadcasts in the background; client doesn't wait on it
        payoutPrivyTxId: null,
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
