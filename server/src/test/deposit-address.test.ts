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
});
