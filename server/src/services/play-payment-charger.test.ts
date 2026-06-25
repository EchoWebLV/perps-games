import { describe, expect, it } from "vitest";
import { makePlayPaymentCharger } from "./play-payment-charger.js";

describe("makePlayPaymentCharger", () => {
  it("signs a server-built play payment with the user's Privy JWT and broadcasts it", async () => {
    const signCalls: unknown[] = [];
    const lookupCalls: unknown[] = [];
    const broadcastCalls: string[] = [];
    const charger = makePlayPaymentCharger({
      depositTxBuilder: {
        async buildForUser(userWallet, amountCents, opts) {
          expect(userWallet).toBe("WalletAAA");
          expect(amountCents).toBe(25);
          expect(opts).toEqual({ feePayer: "user" });
          return { txBase64: "unsigned-or-fee-payer-signed-tx" };
        },
      },
      broadcaster: {
        async broadcast(signedTxBase64) {
          broadcastCalls.push(signedTxBase64);
          return { txSig: "sig-sent" };
        },
      },
      async getWalletIdByAddress(address) {
        lookupCalls.push({ address });
        return "wallet-user-123";
      },
      async signTransaction(walletId, input) {
        signCalls.push({ walletId, input });
        return "fully-signed-tx";
      },
    });

    const out = await charger.charge({
      userWallet: "WalletAAA",
      amountCents: 25,
      userJwt: "jwt-abc",
      idempotencyKey: "play-payment:attempt-1",
    });

    expect(out).toEqual({ txSig: "sig-sent", walletId: "wallet-user-123" });
    expect(lookupCalls).toEqual([{ address: "WalletAAA" }]);
    expect(signCalls).toEqual([
      {
        walletId: "wallet-user-123",
        input: {
          transaction: "unsigned-or-fee-payer-signed-tx",
          authorization_context: { user_jwts: ["jwt-abc"] },
          idempotency_key: "play-payment:attempt-1",
        },
      },
    ]);
    expect(broadcastCalls).toEqual(["fully-signed-tx"]);
  });

  it("uses the configured play signer private key instead of the user's Privy JWT", async () => {
    const signCalls: unknown[] = [];
    const charger = makePlayPaymentCharger({
      signer: { signerId: "key-quorum-play" },
      authorizationPrivateKeys: ["server-private-key"],
      depositTxBuilder: {
        async buildForUser() {
          return { txBase64: "unsigned-tx" };
        },
      },
      broadcaster: {
        async broadcast() {
          return { txSig: "sig-sent" };
        },
      },
      async getWalletIdByAddress() {
        return "wallet-user-123";
      },
      async signTransaction(walletId, input) {
        signCalls.push({ walletId, input });
        return "fully-signed-tx";
      },
    });

    await charger.charge({
      userWallet: "WalletAAA",
      amountCents: 25,
      userJwt: "jwt-abc",
      idempotencyKey: "play-payment:attempt-1",
    });

    expect(charger.signer()).toEqual({ signerId: "key-quorum-play" });
    expect(signCalls).toEqual([
      {
        walletId: "wallet-user-123",
        input: {
          transaction: "unsigned-tx",
          authorization_context: { authorization_private_keys: ["server-private-key"] },
          idempotency_key: "play-payment:attempt-1",
        },
      },
    ]);
  });

  it("prepares an authorization request and charges with the returned signature", async () => {
    const signCalls: unknown[] = [];
    const broadcastCalls: string[] = [];
    const charger = makePlayPaymentCharger({
      privyAppId: "app-123",
      privyApiUrl: "https://api.privy.io",
      requestExpiryMs: 120_000,
      depositTxBuilder: {
        async buildForUser(userWallet, amountCents, opts) {
          expect(userWallet).toBe("WalletAAA");
          expect(amountCents).toBe(25);
          expect(opts).toEqual({ feePayer: "user" });
          return { txBase64: "unsigned-tx" };
        },
      },
      broadcaster: {
        async broadcast(signedTxBase64) {
          broadcastCalls.push(signedTxBase64);
          return { txSig: "sig-sent" };
        },
      },
      async getWalletIdByAddress() { return "wallet-user-123"; },
      async signTransaction(walletId, input) {
        signCalls.push({ walletId, input });
        return "signed-tx";
      },
    });

    const prepared = await charger.prepare({
      userWallet: "WalletAAA",
      amountCents: 25,
      idempotencyKey: "play-payment:user:attempt",
    });
    expect(prepared.walletId).toBe("wallet-user-123");
    expect(prepared.authorizationRequest).toMatchObject({
      version: 1,
      method: "POST",
      url: "https://api.privy.io/v1/wallets/wallet-user-123/rpc",
      body: {
        method: "signTransaction",
        chain_type: "solana",
        params: { transaction: "unsigned-tx", encoding: "base64" },
      },
      headers: {
        "privy-app-id": "app-123",
        "privy-idempotency-key": "play-payment:user:attempt",
      },
    });

    const out = await charger.chargeAuthorized({
      chargeId: prepared.chargeId,
      userWallet: "WalletAAA",
      signature: "auth-signature",
    });

    expect(out).toEqual({ txSig: "sig-sent", walletId: "wallet-user-123" });
    expect(signCalls).toEqual([
      {
        walletId: "wallet-user-123",
        input: {
          transaction: "unsigned-tx",
          authorization_context: { signatures: ["auth-signature"] },
          idempotency_key: "play-payment:user:attempt",
          request_expiry: Number(prepared.authorizationRequest.headers["privy-request-expiry"]),
        },
      },
    ]);
    expect(broadcastCalls).toEqual(["signed-tx"]);
  });

  it("rejects before broadcasting when Privy does not return a signed transaction", async () => {
    const broadcastCalls: string[] = [];
    const charger = makePlayPaymentCharger({
      depositTxBuilder: { async buildForUser() { return { txBase64: "tx" }; } },
      broadcaster: {
        async broadcast(signedTxBase64) {
          broadcastCalls.push(signedTxBase64);
          return { txSig: "sig" };
        },
      },
      async getWalletIdByAddress() { return "wallet-user-123"; },
      async signTransaction() { return null; },
    });

    await expect(
      charger.charge({
        userWallet: "WalletAAA",
        amountCents: 25,
        userJwt: "jwt-abc",
        idempotencyKey: "attempt",
      }),
    ).rejects.toThrow("privy_user_wallet_sign_missing_signed_transaction");
    expect(broadcastCalls).toEqual([]);
  });

  it("rejects before broadcasting when Privy signing times out", async () => {
    const broadcastCalls: string[] = [];
    const charger = makePlayPaymentCharger({
      timeoutMs: 1,
      depositTxBuilder: { async buildForUser() { return { txBase64: "tx" }; } },
      broadcaster: {
        async broadcast(signedTxBase64) {
          broadcastCalls.push(signedTxBase64);
          return { txSig: "sig" };
        },
      },
      async getWalletIdByAddress() { return "wallet-user-123"; },
      async signTransaction() { return new Promise<string>(() => {}); },
    });

    await expect(
      charger.charge({
        userWallet: "WalletAAA",
        amountCents: 25,
        userJwt: "jwt-abc",
        idempotencyKey: "attempt",
      }),
    ).rejects.toThrow("play_payment_charge_sign_timeout");
    expect(broadcastCalls).toEqual([]);
  });

  it("rejects before signing when no Privy wallet ID is available for the address", async () => {
    let signed = false;
    const charger = makePlayPaymentCharger({
      depositTxBuilder: { async buildForUser() { return { txBase64: "tx" }; } },
      broadcaster: { async broadcast() { return { txSig: "sig" }; } },
      async getWalletIdByAddress() { return null; },
      async signTransaction() {
        signed = true;
        return "signed";
      },
    });

    await expect(
      charger.charge({
        userWallet: "WalletAAA",
        amountCents: 25,
        userJwt: "jwt-abc",
        idempotencyKey: "attempt",
      }),
    ).rejects.toThrow("privy_user_wallet_id_missing");
    expect(signed).toBe(false);
  });
});
