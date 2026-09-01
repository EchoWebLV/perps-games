import { afterEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { privateKeyToAccount } from "viem/accounts";
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
    expect(res.json()).toEqual({
      txBase64: "tx-deposit",
      depositIntent: expect.stringMatching(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      expiresAt: new Date(60_000).toISOString(),
    });
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

describe("POST /v1/deposit/send", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("returns 404 when signed deposit broadcasts are disabled", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/send",
      headers: H,
      payload: { depositIntent: "intent", signedTxBase64: "signed-tx" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "deposit_send_disabled" });
  });

  it("broadcasts a fully signed deposit transaction for the authenticated user", async () => {
    let expectedUserId = "";
    ctx = await makeTestDb({
      signedTxBroadcaster: {
        async broadcastSignedDeposit(input) {
          expect(input).toEqual({
            expectedTxBase64: "tx-deposit",
            signedTxBase64: "signed-tx",
          });
          return { txSig: "sig-123" };
        },
      },
      depositIntents: {
        create() {
          return { depositIntent: "unused", expiresAt: new Date(60_000).toISOString() };
        },
        verify() {
          return {
            userId: expectedUserId,
            wallet: "WalletAAA",
            amountCents: 100,
            txBase64: "tx-deposit",
          };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    expectedUserId = user.id;
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/send",
      headers: H,
      payload: { depositIntent: "intent-123", signedTxBase64: "signed-tx" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ txSig: "sig-123" });
  });

  it("accepts a real deposit intent issued by /v1/deposit/build", async () => {
    ctx = await makeTestDb({
      depositTxBuilder: {
        async buildForUser(wallet, amountCents) {
          expect(wallet).toBe("WalletAAA");
          expect(amountCents).toBe(100);
          return { txBase64: "tx-deposit" };
        },
      },
      signedTxBroadcaster: {
        async broadcastSignedDeposit(input) {
          expect(input).toEqual({
            expectedTxBase64: "tx-deposit",
            signedTxBase64: "signed-tx",
          });
          return { txSig: "sig-456" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const buildRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/build",
      headers: H,
      payload: { amountCents: 100 },
    });

    expect(buildRes.statusCode).toBe(200);

    const sendRes = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/send",
      headers: H,
      payload: {
        depositIntent: buildRes.json().depositIntent,
        signedTxBase64: "signed-tx",
      },
    });

    expect(sendRes.statusCode).toBe(200);
    expect(sendRes.json()).toEqual({ txSig: "sig-456" });
  });

  it("rejects a deposit intent for another user", async () => {
    ctx = await makeTestDb({
      signedTxBroadcaster: {
        async broadcastSignedDeposit() {
          throw new Error("should not broadcast");
        },
      },
      depositIntents: {
        create() {
          return { depositIntent: "unused", expiresAt: new Date(60_000).toISOString() };
        },
        verify() {
          return {
            userId: "dev:alice",
            wallet: "WalletAAA",
            amountCents: 100,
            txBase64: "tx-deposit",
          };
        },
      },
    });

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/send",
      headers: H,
      payload: { depositIntent: "intent-123", signedTxBase64: "signed-tx" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_deposit_intent" });
  });

  it("maps signed transaction validation failures to 400 responses", async () => {
    let expectedUserId = "";
    ctx = await makeTestDb({
      signedTxBroadcaster: {
        async broadcastSignedDeposit() {
          throw new Error("signed_transaction_message_mismatch");
        },
      },
      depositIntents: {
        create() {
          return { depositIntent: "unused", expiresAt: new Date(60_000).toISOString() };
        },
        verify() {
          return {
            userId: expectedUserId,
            wallet: "WalletAAA",
            amountCents: 100,
            txBase64: "tx-deposit",
          };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    expectedUserId = user.id;

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/deposit/send",
      headers: H,
      payload: { depositIntent: "intent-123", signedTxBase64: "signed-tx" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "signed_transaction_message_mismatch" });
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

  it("issues the existing wallet owner's session when a second session proves wallet ownership", async () => {
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
    const aliceMe = await ctx.server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-dev-user": "alice" },
    });
    expect(aliceMe.statusCode).toBe(200);

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
    expect(bobBind.statusCode).toBe(200);
    expect(bobBind.json()).toMatchObject({ wallet });
    expect(bobBind.json().token).toEqual(expect.any(String));
    expect(bobBind.json().userId).toEqual(expect.any(String));

    const recoveredMe = await ctx.server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${bobBind.json().token}` },
    });
    expect(recoveredMe.statusCode).toBe(200);
    expect(recoveredMe.json().userId).toBe(aliceMe.json().userId);
  });

  it("rejects a bind with neither signature field", async () => {
    ctx = await makeTestDb();

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers: { "x-dev-user": "alice" },
      payload: { challenge: "v1.whatever.mac" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
  });
});

describe("POST /v1/wallet/bind* — evm family", () => {
  const account = privateKeyToAccount(("0x" + "3".repeat(64)) as `0x${string}`);
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("binds an evm wallet via EIP-191 and stores it lowercased", async () => {
    ctx = await makeTestDb({ walletBindingFamily: "evm" });

    const headers = { "x-dev-user": "alice" };
    const c = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers,
      payload: { wallet: account.address },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().wallet).toBe(account.address.toLowerCase());

    const signature = await account.signMessage({ message: c.json().message });
    const b = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers,
      payload: { challenge: c.json().challenge, signature },
    });

    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ wallet: account.address.toLowerCase() });
    const owner = await ctx.users.getByWalletPublicKey(account.address.toLowerCase());
    expect(owner?.walletPublicKey).toBe(account.address.toLowerCase());
  });

  it("issues the evm wallet owner's session when a second session proves ownership", async () => {
    ctx = await makeTestDb({ walletBindingFamily: "evm" });

    const bind = async (user: string) => {
      const c = await ctx.server.inject({
        method: "POST",
        url: "/v1/wallet/bind-challenge",
        headers: { "x-dev-user": user },
        payload: { wallet: account.address },
      });
      expect(c.statusCode).toBe(200);
      return ctx.server.inject({
        method: "POST",
        url: "/v1/wallet/bind",
        headers: { "x-dev-user": user },
        payload: {
          challenge: c.json().challenge,
          signature: await account.signMessage({ message: c.json().message }),
        },
      });
    };

    expect((await bind("alice")).statusCode).toBe(200);
    const aliceMe = await ctx.server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-dev-user": "alice" },
    });
    expect(aliceMe.statusCode).toBe(200);

    const bobBind = await bind("bob");
    expect(bobBind.statusCode).toBe(200);
    expect(bobBind.json()).toMatchObject({ wallet: account.address.toLowerCase() });
    expect(bobBind.json().token).toEqual(expect.any(String));

    const recoveredMe = await ctx.server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${bobBind.json().token}` },
    });
    expect(recoveredMe.statusCode).toBe(200);
    expect(recoveredMe.json().userId).toBe(aliceMe.json().userId);
  });

  it("rejects an evm bind signed by a different key", async () => {
    const other = privateKeyToAccount(("0x" + "4".repeat(64)) as `0x${string}`);
    ctx = await makeTestDb({ walletBindingFamily: "evm" });

    const headers = { "x-dev-user": "alice" };
    const c = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind-challenge",
      headers,
      payload: { wallet: account.address },
    });
    expect(c.statusCode).toBe(200);

    const b = await ctx.server.inject({
      method: "POST",
      url: "/v1/wallet/bind",
      headers,
      payload: {
        challenge: c.json().challenge,
        signature: await other.signMessage({ message: c.json().message }),
      },
    });

    expect(b.statusCode).toBe(401);
    expect(b.json()).toEqual({ error: "invalid_wallet_signature" });
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
