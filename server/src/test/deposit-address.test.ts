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
        async buildForUser(wallet, amountCents) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(100);
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
        async buildForUser(wallet, amountCents) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(25);
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
