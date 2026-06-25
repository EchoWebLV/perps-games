import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };
const BEARER_H = { authorization: "Bearer jwt-abc", "content-type": "application/json" };

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
        async confirm(input: { txSig: string; userId: string; sourceOwner: string }) {
          expect(input.txSig).toBe("sig-play-123");
          expect(input.sourceOwner).toBe("WalletAAA");
          const user = await ctx.users.upsertByExternalId("dev:mallory");
          expect(input.userId).toBe(user.id);
          await ctx.ledger.credit(user.id, "cash", 25, "deposit", input.txSig);
          return { status: "credited", amountCents: 25, paymentCents: 25, txSigs: [input.txSig] };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/confirm",
      headers: H,
      payload: { txSig: "sig-play-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "credited", amountCents: 25, paymentCents: 25, txSigs: ["sig-play-123"], balance: 25 });
  });

  it("refunds extra matching payments after a returned Privy signature", async () => {
    const sends: unknown[] = [];
    ctx = await makeTestDb({
      stakeAsset: "cash",
      playPaymentConfirmer: {
        async confirm(input: { txSig: string; sourceOwner: string }) {
          expect(input.txSig).toBe("sig-play-123");
          expect(input.sourceOwner).toBe("WalletAAA");
          const user = await ctx.users.upsertByExternalId("dev:mallory");
          await ctx.ledger.credit(user.id, "cash", 50, "deposit", "sig-play-123");
          return { status: "credited", amountCents: 50, paymentCents: 25, txSigs: ["sig-play-123", "sig-extra"] };
        },
      },
      payoutSigner: {
        async signAndSend(input) {
          sends.push(input);
          return { txSig: "sig-refund", privyTxId: "privy-refund" };
        },
      },
    });
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/confirm",
      headers: H,
      payload: { txSig: "sig-play-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "credited",
      amountCents: 25,
      recoveredCents: 50,
      refundedCents: 25,
      refundTxSig: "sig-refund",
      balance: 25,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ destWallet: "WalletAAA", amountCents: 25 });
    expect(await ctx.ledger.balance(user.id, "cash")).toBe(25);
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
          return { status: "credited", amountCents: 25, paymentCents: 25, txSigs: ["sig-recovered"] };
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
    expect(res.json()).toEqual({ status: "credited", amountCents: 25, paymentCents: 25, txSigs: ["sig-recovered"], balance: 25 });
  });

  it("refunds extra recovered Privy payments and leaves one stake credited", async () => {
    const sends: unknown[] = [];
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
          await ctx.ledger.credit(user.id, "cash", 75, "deposit", "sig-recovery-batch");
          return { status: "credited", amountCents: 75, paymentCents: 25, txSigs: ["sig-one", "sig-two", "sig-three"] };
        },
      },
      payoutSigner: {
        async signAndSend(input) {
          sends.push(input);
          return { txSig: "sig-refund", privyTxId: "privy-refund" };
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
    expect(res.json()).toMatchObject({
      status: "credited",
      amountCents: 25,
      paymentCents: 25,
      recoveredCents: 75,
      refundedCents: 50,
      refundTxSig: "sig-refund",
      refundPrivyTxId: "privy-refund",
      balance: 25,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ destWallet: "WalletAAA", amountCents: 50 });
    expect((sends[0] as { idempotencyKey?: string }).idempotencyKey).toMatch(/^play-payment-refund:/);
    expect(await ctx.ledger.balance(user.id, "cash")).toBe(25);
  });
});

describe("POST /v1/play/payment/charge", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns the configured Privy play signer without exposing its private key", async () => {
    ctx = await makeTestDb({
      devAuth: false,
      privyAuth: {
        async verifyAccessToken() { return "did:privy:user"; },
        async fetchSolanaWallet() { return "WalletAAA"; },
      },
      playPaymentCharger: {
        signer() {
          return { signerId: "key-quorum-play", policyIds: ["policy-play"] };
        },
        async charge() {
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
        async prepare() {
          throw new Error("unused");
        },
        async chargeAuthorized() {
          throw new Error("unused");
        },
      },
    } as any);

    const res = await ctx.server.inject({
      method: "GET",
      url: "/v1/play/payment/signer",
      headers: BEARER_H,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signers: [{ signerId: "key-quorum-play", policyIds: ["policy-play"] }] });
    expect(JSON.stringify(res.json())).not.toContain("private");
  });

  it("returns 404 when server-side play payment charging is disabled", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/charge",
      headers: H,
      payload: { amountCents: 25, attemptId: "attempt-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "play_payment_charge_disabled" });
  });

  it("rejects server-side charging without a Privy bearer token", async () => {
    const calls: unknown[] = [];
    ctx = await makeTestDb({
      playPaymentCharger: {
        async charge(input: unknown) {
          calls.push(input);
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
      },
    } as any);
    const user = await ctx.users.upsertByExternalId("dev:mallory");
    await ctx.users.setWalletPublicKey(user.id, "WalletAAA");

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/charge",
      headers: H,
      payload: { amountCents: 25, attemptId: "attempt-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "privy_token_required" });
    expect(calls).toEqual([]);
  });

  it("charges from the authenticated Privy wallet and returns the sent signature", async () => {
    const calls: unknown[] = [];
    ctx = await makeTestDb({
      devAuth: false,
      privyAuth: {
        async verifyAccessToken(token: string) {
          expect(token).toBe("jwt-abc");
          return "did:privy:user";
        },
        async fetchSolanaWallet(did: string, preferred?: string | null) {
          expect(did).toBe("did:privy:user");
          expect(preferred).toBeNull();
          return "WalletAAA";
        },
      },
      playPaymentCharger: {
        async charge(input: unknown) {
          calls.push(input);
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
      },
    } as any);

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/charge",
      headers: BEARER_H,
      payload: { amountCents: 25, attemptId: "attempt-1" },
    });

    const user = await ctx.users.upsertByExternalId("privy:did:privy:user");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "sent", txSig: "sig-sent" });
    expect(calls).toEqual([
      {
        userWallet: "WalletAAA",
        amountCents: 25,
        userJwt: "jwt-abc",
        idempotencyKey: `play-payment:${user.id}:attempt-1`,
      },
    ]);
  });

  it("accepts a charge from an older client without an attempt id", async () => {
    const calls: any[] = [];
    ctx = await makeTestDb({
      devAuth: false,
      privyAuth: {
        async verifyAccessToken() { return "did:privy:user"; },
        async fetchSolanaWallet() { return "WalletAAA"; },
      },
      playPaymentCharger: {
        async charge(input: unknown) {
          calls.push(input);
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
      },
    } as any);

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/charge",
      headers: BEARER_H,
      payload: { amountCents: 25 },
    });

    const user = await ctx.users.upsertByExternalId("privy:did:privy:user");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "sent", txSig: "sig-sent" });
    expect(calls[0]).toMatchObject({
      userWallet: "WalletAAA",
      amountCents: 25,
      userJwt: "jwt-abc",
    });
    expect(calls[0].idempotencyKey).toMatch(new RegExp(`^play-payment:${user.id}:[A-Za-z0-9_-]+$`));
  });

  it("prepares and submits a Privy authorization-signature charge", async () => {
    const calls: any[] = [];
    ctx = await makeTestDb({
      devAuth: false,
      privyAuth: {
        async verifyAccessToken() { return "did:privy:user"; },
        async fetchSolanaWallet() { return "WalletAAA"; },
      },
      playPaymentCharger: {
        async prepare(input: unknown) {
          calls.push({ kind: "prepare", input });
          return {
            chargeId: "11111111-1111-4111-8111-111111111111",
            walletId: "wallet-user-123",
            authorizationRequest: {
              version: 1,
              method: "POST",
              url: "https://api.privy.io/v1/wallets/wallet-user-123/rpc",
              body: { method: "signTransaction", chain_type: "solana", params: { transaction: "tx", encoding: "base64" } },
              headers: { "privy-app-id": "app", "privy-idempotency-key": "idem", "privy-request-expiry": "1" },
            },
          };
        },
        async chargeAuthorized(input: unknown) {
          calls.push({ kind: "chargeAuthorized", input });
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
        async charge() {
          return { txSig: "sig-sent", walletId: "wallet-user-123" };
        },
      },
    } as any);

    const prepare = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/prepare",
      headers: BEARER_H,
      payload: { amountCents: 25, attemptId: "attempt-1" },
    });
    const charge = await ctx.server.inject({
      method: "POST",
      url: "/v1/play/payment/charge-authorized",
      headers: BEARER_H,
      payload: { chargeId: "11111111-1111-4111-8111-111111111111", signature: "auth-sig" },
    });

    const user = await ctx.users.upsertByExternalId("privy:did:privy:user");
    expect(prepare.statusCode).toBe(200);
    expect(charge.statusCode).toBe(200);
    expect(charge.json()).toEqual({ status: "sent", txSig: "sig-sent" });
    expect(calls).toEqual([
      {
        kind: "prepare",
        input: {
          userWallet: "WalletAAA",
          amountCents: 25,
          idempotencyKey: `play-payment:${user.id}:attempt-1`,
        },
      },
      {
        kind: "chargeAuthorized",
        input: {
          userWallet: "WalletAAA",
          chargeId: "11111111-1111-4111-8111-111111111111",
          signature: "auth-sig",
        },
      },
    ]);
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
