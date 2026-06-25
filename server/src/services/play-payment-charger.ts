import type { PrivyClient } from "@privy-io/node";
import { randomUUID } from "node:crypto";
import type { DepositTxBuilder } from "./deposit-tx.js";
import type { PlayPaymentBroadcaster } from "./play-payment-broadcaster.js";

export interface PlayPaymentChargeInput {
  userWallet: string;
  amountCents: number;
  userJwt?: string;
  idempotencyKey: string;
}

export interface PlayPaymentChargeResult {
  txSig: string;
  walletId: string;
}

export interface PlayPaymentAuthorizationRequest {
  version: 1;
  method: "POST";
  url: string;
  body: {
    method: "signTransaction";
    chain_type: "solana";
    params: { transaction: string; encoding: "base64" };
  };
  headers: {
    "privy-app-id": string;
    "privy-idempotency-key": string;
    "privy-request-expiry": string;
  };
}

export interface PlayPaymentPrepareInput {
  userWallet: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface PlayPaymentPrepareResult {
  chargeId: string;
  walletId: string;
  authorizationRequest: PlayPaymentAuthorizationRequest;
}

export interface PlayPaymentAuthorizedChargeInput {
  chargeId: string;
  userWallet: string;
  signature: string;
}

export interface PlayPaymentSigner {
  signerId: string;
  policyIds?: string[];
}

export interface PlayPaymentCharger {
  charge(input: PlayPaymentChargeInput): Promise<PlayPaymentChargeResult>;
  prepare(input: PlayPaymentPrepareInput): Promise<PlayPaymentPrepareResult>;
  chargeAuthorized(input: PlayPaymentAuthorizedChargeInput): Promise<PlayPaymentChargeResult>;
  signer(): PlayPaymentSigner | null;
}

async function withTimeout<T>(label: string, ms: number, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`play_payment_charge_${label}_timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function makePlayPaymentCharger(deps: {
  depositTxBuilder: DepositTxBuilder;
  broadcaster: PlayPaymentBroadcaster;
  privy?: PrivyClient;
  privyAppId?: string;
  privyApiUrl?: string;
  signer?: PlayPaymentSigner;
  authorizationPrivateKeys?: string[];
  timeoutMs?: number;
  pendingTtlMs?: number;
  requestExpiryMs?: number;
  getWalletIdByAddress?: (address: string) => Promise<string | null>;
  signTransaction?: (
    walletId: string,
    input: {
      transaction: string;
      authorization_context: { authorization_private_keys?: string[]; user_jwts?: string[]; signatures?: string[] };
      idempotency_key: string;
      request_expiry?: number;
    },
  ) => Promise<string | null>;
}): PlayPaymentCharger {
  const privyAppId = deps.privyAppId ?? ((deps.privy as any)?.appId as string | undefined);
  const privyApiUrl = (deps.privyApiUrl ?? "https://api.privy.io").replace(/\/$/, "");
  const authorizationPrivateKeys = (deps.authorizationPrivateKeys ?? []).filter(Boolean);
  const pending = new Map<string, {
    userWallet: string;
    walletId: string;
    txBase64: string;
    idempotencyKey: string;
    requestExpiry: number;
    expiresAt: number;
  }>();
  const getWalletIdByAddress = deps.getWalletIdByAddress ?? (async (walletAddress: string) => {
    if (!deps.privy) throw new Error("privy_client_required");
    const wallet = await deps.privy.wallets().getWalletByAddress({ address: walletAddress });
    return wallet.id ?? null;
  });
  const signTransaction = deps.signTransaction ?? (async (walletId, input) => {
    if (!deps.privy) throw new Error("privy_client_required");
    const res = await (deps.privy.wallets().solana() as any).signTransaction(walletId, input);
    return res?.signed_transaction ?? res?.data?.signed_transaction ?? null;
  });
  const timeoutMs = deps.timeoutMs ?? 12_000;
  const pendingTtlMs = deps.pendingTtlMs ?? 120_000;
  const requestExpiryMs = deps.requestExpiryMs ?? 120_000;

  function prunePending(now = Date.now()) {
    for (const [chargeId, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(chargeId);
    }
  }

  async function buildPreparedCharge({ userWallet, amountCents, idempotencyKey }: PlayPaymentPrepareInput): Promise<PlayPaymentPrepareResult> {
    if (!privyAppId) throw new Error("privy_app_id_required");
    prunePending();
    const walletId = await withTimeout("wallet_lookup", timeoutMs, getWalletIdByAddress(userWallet));
    if (!walletId) throw new Error("privy_user_wallet_id_missing");
    const { txBase64 } = await deps.depositTxBuilder.buildForUser(userWallet, amountCents, { feePayer: "user" });
    const chargeId = randomUUID();
    const requestExpiry = Date.now() + requestExpiryMs;
    pending.set(chargeId, {
      userWallet,
      walletId,
      txBase64,
      idempotencyKey,
      requestExpiry,
      expiresAt: Date.now() + pendingTtlMs,
    });
    return {
      chargeId,
      walletId,
      authorizationRequest: {
        version: 1,
        method: "POST",
        url: `${privyApiUrl}/v1/wallets/${walletId}/rpc`,
        body: {
          method: "signTransaction",
          chain_type: "solana",
          params: { transaction: txBase64, encoding: "base64" },
        },
        headers: {
          "privy-app-id": privyAppId,
          "privy-idempotency-key": idempotencyKey,
          "privy-request-expiry": String(requestExpiry),
        },
      },
    };
  }

  async function broadcastSignedTx(input: {
    walletId: string;
    txBase64: string;
    idempotencyKey: string;
    authorizationContext: { authorization_private_keys?: string[]; user_jwts?: string[]; signatures?: string[] };
    requestExpiry?: number;
  }): Promise<PlayPaymentChargeResult> {
    let signedTx: string | null;
    try {
      signedTx = await withTimeout("sign", timeoutMs, signTransaction(input.walletId, {
        transaction: input.txBase64,
        authorization_context: input.authorizationContext,
        idempotency_key: input.idempotencyKey,
        ...(input.requestExpiry ? { request_expiry: input.requestExpiry } : {}),
      }));
    } catch (e) {
      if (e instanceof Error && e.message === "play_payment_charge_sign_timeout") throw e;
      throw new Error("privy_user_wallet_sign_failed", { cause: e });
    }
    if (!signedTx) throw new Error("privy_user_wallet_sign_missing_signed_transaction");
    const { txSig } = await deps.broadcaster.broadcast(signedTx);
    return { txSig, walletId: input.walletId };
  }

  return {
    signer: () => deps.signer ?? null,
    prepare: buildPreparedCharge,
    async chargeAuthorized({ chargeId, userWallet, signature }) {
      prunePending();
      const entry = pending.get(chargeId);
      if (!entry) throw new Error("play_payment_charge_not_prepared");
      if (entry.userWallet !== userWallet) throw new Error("play_payment_charge_wallet_mismatch");
      pending.delete(chargeId);
      return broadcastSignedTx({
        walletId: entry.walletId,
        txBase64: entry.txBase64,
        idempotencyKey: entry.idempotencyKey,
        authorizationContext: { signatures: [signature] },
        requestExpiry: entry.requestExpiry,
      });
    },
    async charge({ userWallet, amountCents, userJwt, idempotencyKey }) {
      const walletId = await withTimeout("wallet_lookup", timeoutMs, getWalletIdByAddress(userWallet));
      if (!walletId) throw new Error("privy_user_wallet_id_missing");
      const { txBase64 } = await deps.depositTxBuilder.buildForUser(userWallet, amountCents, { feePayer: "user" });
      const authorizationContext = authorizationPrivateKeys.length > 0
        ? { authorization_private_keys: authorizationPrivateKeys }
        : userJwt
          ? { user_jwts: [userJwt] }
          : null;
      if (!authorizationContext) throw new Error("privy_play_signer_required");
      return broadcastSignedTx({
        walletId,
        txBase64,
        idempotencyKey,
        authorizationContext,
      });
    },
  };
}
