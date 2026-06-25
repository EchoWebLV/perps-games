import { afterEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("GET /v1/deposit/address", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("returns 404 deposits_disabled when real money is off", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({ method: "GET", url: "/v1/deposit/address", headers: H });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "deposits_disabled" });
  });

  it("returns the treasury ATA and boundWallet when real money is enabled", async () => {
    ctx = await makeTestDb({ realMoney: { enabled: true, treasuryUsdcAta: "TREASURYata123" } });

    const res = await ctx.server.inject({ method: "GET", url: "/v1/deposit/address", headers: H });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      treasuryUsdcAta: "TREASURYata123",
      boundWallet: null,
      note: "send USDC from your bound wallet to treasuryUsdcAta; credited after on-chain finality",
    });
  });
});

describe("GET /v1/wallet/usdc-balance", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("returns 404 when wallet balance reads are disabled", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "wallet_balance_disabled" });
  });

  it("returns the bound wallet USDC balance", async () => {
    ctx = await makeTestDb({
      walletBalanceReader: {
        async balanceCents(wallet) {
          return wallet === "WalletAAA" ? 100 : 0;
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wallet: "WalletAAA", balance: 100 });
  });

  it("returns 503 when the wallet balance reader fails", async () => {
    ctx = await makeTestDb({
      walletBalanceReader: {
        async balanceCents() {
          throw new Error("rpc unavailable");
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/wallet/usdc-balance", headers: H });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "wallet_balance_unavailable" });
  });
});

describe("POST /v1/deposit/build", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("returns 404 when deposits are disabled", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: H,
      payload: { amountCents: 100 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "deposits_disabled" });
  });

  it("builds a deposit transaction for the bound wallet", async () => {
    ctx = await makeTestDb({
      depositTxBuilder: {
        async buildForUser(wallet, amountCents, opts) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(100);
          expect(opts).toBeUndefined();
          return { txBase64: "tx-deposit" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: H,
      payload: { amountCents: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txBase64: "tx-deposit" });
  });

  it("enforces the configured deposit bounds", async () => {
    ctx = await makeTestDb({
      depositMinCents: 100,
      depositMaxCents: 200,
      depositTxBuilder: {
        async buildForUser() {
          throw new Error("should not build");
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: H,
      payload: { amountCents: 25 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "amount_out_of_bounds" });
  });

  it("returns 409 when the user has no bound wallet", async () => {
    ctx = await makeTestDb({
      depositTxBuilder: {
        async buildForUser() {
          throw new Error("should not build");
        },
      },
    });

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: H,
      payload: { amountCents: 100 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "no_bound_wallet" });
  });
});

describe("POST /v1/wallet/bind*", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("rejects invalid wallet input when issuing a bind challenge", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers: { "x-dev-user": "alice" },
      payload: { wallet: "0".repeat(32) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_wallet_address" });
  });

  it("binds a wallet only after a valid wallet signature", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    ctx = await makeTestDb();

    const headers = { "x-dev-user": "alice" };
    const c = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers,
      payload: { wallet },
    });
    expect(c.statusCode).toBe(200);

    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(c.json().message), secretKey),
    );
    const b = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers,
      payload: { challenge: c.json().challenge, signatureBase58 },
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ wallet });
  });

  it("rejects a challenge signed for another authenticated user", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    ctx = await makeTestDb();

    const challengeRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers: { "x-dev-user": "alice" },
      payload: { wallet },
    });
    expect(challengeRes.statusCode).toBe(200);

    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(challengeRes.json().message), secretKey),
    );
    const bindRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "bob" },
      payload: { challenge: challengeRes.json().challenge, signatureBase58 },
    });

    expect(bindRes.statusCode).toBe(401);
    expect(bindRes.json()).toEqual({ error: "invalid_wallet_signature" });
  });

  it("rejects a tampered challenge or signature", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    ctx = await makeTestDb();

    const challengeRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers: { "x-dev-user": "alice" },
      payload: { wallet },
    });
    expect(challengeRes.statusCode).toBe(200);

    const validSignatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(challengeRes.json().message), secretKey),
    );
    const tamperedChallenge = `${challengeRes.json().challenge}tampered`;
    const tamperedChallengeRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "alice" },
      payload: { challenge: tamperedChallenge, signatureBase58: validSignatureBase58 },
    });
    expect(tamperedChallengeRes.statusCode).toBe(401);
    expect(tamperedChallengeRes.json()).toEqual({ error: "invalid_wallet_signature" });

    const tamperedSignature = bs58.encode(
      Uint8Array.from(bs58.decode(validSignatureBase58), (byte, index) => (index === 0 ? byte ^ 1 : byte)),
    );
    const tamperedSignatureRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "alice" },
      payload: { challenge: challengeRes.json().challenge, signatureBase58: tamperedSignature },
    });
    expect(tamperedSignatureRes.statusCode).toBe(401);
    expect(tamperedSignatureRes.json()).toEqual({ error: "invalid_wallet_signature" });
  });

  it("returns wallet_already_bound when a second user claims an existing wallet", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    const wallet = bs58.encode(publicKey);
    ctx = await makeTestDb();

    const aliceChallenge = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers: { "x-dev-user": "alice" },
      payload: { wallet },
    });
    expect(aliceChallenge.statusCode).toBe(200);

    const signatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(aliceChallenge.json().message), secretKey),
    );
    const aliceBind = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "alice" },
      payload: { challenge: aliceChallenge.json().challenge, signatureBase58 },
    });
    expect(aliceBind.statusCode).toBe(200);

    const bobChallenge = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers: { "x-dev-user": "bob" },
      payload: { wallet },
    });
    expect(bobChallenge.statusCode).toBe(200);

    const bobSignatureBase58 = bs58.encode(
      await ed.signAsync(new TextEncoder().encode(bobChallenge.json().message), secretKey),
    );
    const bobBind = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "bob" },
      payload: { challenge: bobChallenge.json().challenge, signatureBase58: bobSignatureBase58 },
    });
    expect(bobBind.statusCode).toBe(409);
    expect(bobBind.json()).toEqual({ error: "wallet_already_bound" });
  });
});

describe("removed play-payment rail", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("does not expose the old play-payment rail", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/build",
      headers: { "x-dev-user": "alice" },
      payload: { amountCents: 100 },
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not expose play-payment build even when deposits are enabled", async () => {
    ctx = await makeTestDb({
      depositTxBuilder: {
        async buildForUser() {
          return { txBase64: "tx-play" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/build",
      headers: H,
      payload: { amountCents: 100 },
    });

    expect(res.statusCode).toBe(404);
  });
});
