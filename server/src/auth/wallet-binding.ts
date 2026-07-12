import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { verifyAsync } from "@noble/ed25519";

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface WalletBinding {
  createChallenge(input: {
    userId: string;
    wallet: string;
  }): { challenge: string; message: string; wallet: string; expiresAt: string };
  verifyChallenge(input: {
    challenge: string;
    signatureBase58: string;
  }): Promise<{ userId: string; wallet: string } | null>;
}

export function createWalletBinding(deps: {
  secret: string;
  now?: () => number;
  ttlMs?: number;
}): WalletBinding {
  if (deps.secret.length < 32) {
    throw new Error("wallet binding secret must be at least 32 characters");
  }
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
  const sign = (payload: string) =>
    createHmac("sha256", deps.secret).update(payload).digest("base64url");
  const messageFor = (p: {
    userId: string;
    wallet: string;
    nonce: string;
    exp: number;
  }) =>
    [
      "Perps Raider wallet binding",
      `Wallet: ${p.wallet}`,
      `Session: ${p.userId}`,
      `Nonce: ${p.nonce}`,
      `Expires: ${new Date(p.exp).toISOString()}`,
    ].join("\n");

  return {
    createChallenge({ userId, wallet }) {
      if (!SOLANA_ADDRESS_RE.test(wallet)) {
        throw new Error("invalid_wallet_address");
      }
      const payloadObj = {
        userId,
        wallet,
        nonce: randomBytes(16).toString("hex"),
        exp: now() + ttlMs,
      };
      const message = messageFor(payloadObj);
      const payload = b64url(JSON.stringify({ ...payloadObj, message }));
      return {
        challenge: `v1.${payload}.${sign(payload)}`,
        message,
        wallet,
        expiresAt: new Date(payloadObj.exp).toISOString(),
      };
    },
    async verifyChallenge({ challenge, signatureBase58 }) {
      const parts = challenge.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const expected = sign(parts[1]);
      const a = Buffer.from(parts[2]);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

      let payload: { userId?: string; wallet?: string; exp?: number; message?: string };
      try {
        payload = JSON.parse(fromB64url(parts[1]));
      } catch {
        return null;
      }
      if (!payload.userId || !payload.wallet || !payload.message || typeof payload.exp !== "number") {
        return null;
      }
      if (payload.exp <= now() || !SOLANA_ADDRESS_RE.test(payload.wallet)) return null;

      let signature: Uint8Array;
      let publicKey: Uint8Array;
      try {
        signature = bs58.decode(signatureBase58);
        publicKey = bs58.decode(payload.wallet);
      } catch {
        return null;
      }
      if (signature.length !== 64 || publicKey.length !== 32) return null;

      const ok = await verifyAsync(signature, enc.encode(payload.message), publicKey);
      return ok ? { userId: payload.userId, wallet: payload.wallet } : null;
    },
  };
}
