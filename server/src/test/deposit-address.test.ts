import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("GET /v1/deposit/address", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 deposits_disabled when real money is off (default harness)", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "GET", url: "/v1/deposit/address", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "deposits_disabled" });
  });

  it("returns the treasury ATA and boundWallet when real money is enabled", async () => {
    ctx = await makeTestDb({ realMoney: { enabled: true, treasuryUsdcAta: "TREASURYata123" } });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/deposit/address", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.treasuryUsdcAta).toBe("TREASURYata123");
    expect(body).toHaveProperty("boundWallet");
    expect(body.boundWallet).toBeNull();
  });
});

describe("GET /v1/wallet/usdc-balance", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 when wallet balance reads are disabled", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "wallet_balance_disabled" });
  });

  it("returns the bound Privy wallet USDC balance", async () => {
    ctx = await makeTestDb({
      walletBalanceReader: { async balanceCents(wallet) { return wallet === "WalletAAA" ? 100 : 0; } },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wallet: "WalletAAA", balance: 100 });
  });

  it("does not turn wallet balance RPC failures into a zero balance", async () => {
    ctx = await makeTestDb({
      walletBalanceReader: { async balanceCents() { throw new Error("rpc unavailable"); } },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "wallet_balance_unavailable" });
  });
});

describe("POST /v1/play/payment/build", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 when play payments are disabled", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "POST", url: "/v1/play/payment/build", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "play_payments_disabled" });
  });

  it("builds a user wallet to vault payment transaction", async () => {
    ctx = await makeTestDb({
      depositTxBuilder: {
        async buildForUser(wallet, amountCents, opts) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(100);
          expect(opts).toEqual({ feePayer: "user" });
          return { txBase64: "tx-play" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "POST", url: "/v1/play/payment/build", headers: H, payload: { amountCents: 100 } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txBase64: "tx-play" });
  });

  it("allows a $0.25 play payment even when deposits require a $1.00 minimum", async () => {
    ctx = await makeTestDb({
      depositMinCents: 100,
      depositTxBuilder: {
        async buildForUser(wallet, amountCents, opts) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(25);
          expect(opts).toEqual({ feePayer: "user" });
          return { txBase64: "tx-play-quarter" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "POST", url: "/v1/play/payment/build", headers: H, payload: { amountCents: 25 } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txBase64: "tx-play-quarter" });
  });
});

describe("POST /v1/play/payment/confirm", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("confirms the exact sent payment signature and returns the credited cash balance", async () => {
    ctx = await makeTestDb({
      stakeAsset: "cash",
      playPaymentConfirmer: {
        async confirm(txSig: string) {
          expect(txSig).toBe("sig-play-123");
          const user = await ctx.users.upsertByExternalId("dev:mallory");
          await ctx.ledger.credit(user.id, "cash", 25, "deposit", txSig);
          return { status: "credited" };
        },
      },
    });

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/confirm",
      headers: H,
      payload: { txSig: "sig-play-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "credited", balance: 25 });
  });
});

describe("POST /v1/play/payment/recover", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("recovers a landed payment by wallet and returns the credited cash balance", async () => {
    ctx = await makeTestDb({
      stakeAsset: "cash",
      playPaymentConfirmer: {
        async confirm() {
          throw new Error("confirm should not be called");
        },
        async recover(input: { userId: string; sourceOwner: string; amountCents: number }) {
          expect(input.sourceOwner).toBe("WalletAAA");
          expect(input.amountCents).toBe(25);
          const user = await ctx.users.upsertByExternalId("dev:mallory");
          expect(input.userId).toBe(user.id);
          await ctx.ledger.credit(user.id, "cash", 25, "deposit", "sig-recovered");
          return { status: "credited", amountCents: 25 };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/recover",
      headers: H,
      payload: { amountCents: 25 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "credited", amountCents: 25, balance: 25 });
  });
});

describe("POST /v1/play/payment/send", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 when signed play payment broadcasting is disabled", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/send",
      headers: H,
      payload: { signedTxBase64: "signed-play-tx" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "play_payment_send_disabled" });
  });

  it("broadcasts the signed play payment transaction and returns its signature", async () => {
    ctx = await makeTestDb({
      playPaymentBroadcaster: {
        async broadcast(signedTxBase64: string) {
          expect(signedTxBase64).toBe("signed-play-tx");
          return { txSig: "sig-play-123" };
        },
      },
    });

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/send",
      headers: H,
      payload: { signedTxBase64: "signed-play-tx" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txSig: "sig-play-123" });
  });
});
