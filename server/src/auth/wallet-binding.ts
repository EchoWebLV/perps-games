import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { verifyAsync } from "@noble/ed25519";
import { verifyMessage } from "viem";

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");
/** Single source of truth for the address shapes — scripts import these instead of re-declaring. */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
/**
 * Domain tag mixed into the binding MAC. SESSION_SECRET also backs auth/session.ts and
 * services/deposit-intents.ts, which use an identical `v1.<b64url>.<hmac>` envelope; tagging makes
 * a binding challenge structurally un-forgeable from either of those token families.
 */
const MAC_DOMAIN = "wallet-bind.v1|";

export type ChainFamily = "solana" | "evm";

/**
 * Case-fold EVM-shaped wallet values before comparing them. EVM addresses are stored lowercased,
 * but clients (viem) hand back the EIP-55 checksummed form; base58 Solana addresses are
 * case-SIGNIFICANT and must be compared verbatim.
 */
export function normalizeWalletForCompare(wallet: string): string {
  return EVM_ADDRESS_RE.test(wallet) ? wallet.toLowerCase() : wallet;
}

export interface WalletBinding {
  createChallenge(input: {
    userId: string;
    wallet: string;
  }): { challenge: string; message: string; wallet: string; expiresAt: string };
  verifyChallenge(input: {
    challenge: string;
    /** 0x-hex EIP-191 signature (EVM). Preferred field. */
    signature?: string;
    /** base58 ed25519 signature (Solana). */
    signatureBase58?: string;
  }): Promise<{ userId: string; wallet: string } | null>;
}

export function createWalletBinding(deps: {
  secret: string;
  now?: () => number;
  ttlMs?: number;
  family?: ChainFamily;
}): WalletBinding {
  if (deps.secret.length < 32) {
    throw new Error("wallet binding secret must be at least 32 characters");
  }
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
  const family: ChainFamily = deps.family ?? "solana";
  // EVM addresses are stored + signed lowercased so bound-wallet == deposit-source `from` is exact.
  const normalize = (wallet: string) => (family === "evm" ? wallet.toLowerCase() : wallet);
  const addressOk = (wallet: string) =>
    family === "evm" ? EVM_ADDRESS_RE.test(wallet) : SOLANA_ADDRESS_RE.test(wallet);
  const sign = (payload: string) =>
    createHmac("sha256", deps.secret).update(MAC_DOMAIN + payload).digest("base64url");
  // Single-use challenges: nonce → challenge exp. In-process by design — the deployment is a single
  // server process, a restart forgives outstanding nonces, and the 5-min TTL bounds the exposure.
  const usedNonces = new Map<string, number>();
  /** true when the nonce was fresh (and is now spent); false when it was already consumed. */
  const consumeNonce = (nonce: string, exp: number): boolean => {
    if (usedNonces.has(nonce)) return false;
    const t = now();
    for (const [k, e] of usedNonces) if (e <= t) usedNonces.delete(k); // opportunistic sweep
    usedNonces.set(nonce, exp);
    return true;
  };
  const messageFor = (p: {
    userId: string;
    wallet: string;
    nonce: string;
    exp: number;
  }) =>
    [
      "Perps Rider wallet binding",
      `Wallet: ${p.wallet}`,
      `Session: ${p.userId}`,
      `Nonce: ${p.nonce}`,
      `Expires: ${new Date(p.exp).toISOString()}`,
    ].join("\n");

  return {
    createChallenge({ userId, wallet: rawWallet }) {
      if (!addressOk(rawWallet)) {
        throw new Error("invalid_wallet_address");
      }
      const wallet = normalize(rawWallet);
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
    async verifyChallenge({ challenge, signature: signatureHex, signatureBase58 }) {
      const parts = challenge.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const expected = sign(parts[1]);
      const a = Buffer.from(parts[2]);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

      let payload: {
        userId?: string;
        wallet?: string;
        exp?: number;
        message?: string;
        nonce?: string;
      };
      try {
        payload = JSON.parse(fromB64url(parts[1]));
      } catch {
        return null;
      }
      if (
        !payload.userId ||
        !payload.wallet ||
        !payload.message ||
        !payload.nonce ||
        typeof payload.exp !== "number"
      ) {
        return null;
      }
      if (payload.exp <= now() || !addressOk(payload.wallet)) return null;
      // A spent nonce is checked BEFORE the signature so a replay can never re-issue a session; the
      // nonce is only marked spent once the signature actually verifies (a typo must not burn it).
      if (usedNonces.has(payload.nonce)) return null;
      const { nonce, exp } = payload as { nonce: string; exp: number };

      if (family === "evm") {
        const sig = signatureHex ?? "";
        if (!EVM_SIGNATURE_RE.test(sig)) return null;
        const wallet = payload.wallet.toLowerCase();
        let ok: boolean;
        try {
          ok = await verifyMessage({
            address: wallet as `0x${string}`,
            message: payload.message,
            signature: sig as `0x${string}`,
          });
        } catch {
          return null;
        }
        if (!ok || !consumeNonce(nonce, exp)) return null;
        return { userId: payload.userId, wallet };
      }

      let signature: Uint8Array;
      let publicKey: Uint8Array;
      try {
        signature = bs58.decode(signatureBase58 ?? "");
        publicKey = bs58.decode(payload.wallet);
      } catch {
        return null;
      }
      if (signature.length !== 64 || publicKey.length !== 32) return null;

      const ok = await verifyAsync(signature, enc.encode(payload.message), publicKey);
      if (!ok || !consumeNonce(nonce, exp)) return null;
      return { userId: payload.userId, wallet: payload.wallet };
    },
  };
}
