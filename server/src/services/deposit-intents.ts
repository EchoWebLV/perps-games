import { createHmac, timingSafeEqual } from "node:crypto";

export interface DepositIntentPayload {
  userId: string;
  wallet: string;
  amountCents: number;
  txBase64: string;
}

export interface DepositIntents {
  create(input: DepositIntentPayload): { depositIntent: string; expiresAt: string };
  verify(depositIntent: string): DepositIntentPayload | null;
}

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function makeDepositIntents(deps: { secret: string; now?: () => number; ttlMs?: number }): DepositIntents {
  if (deps.secret.length < 32) throw new Error("deposit intent secret must be at least 32 characters");
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
  const sign = (payload: string) => createHmac("sha256", deps.secret).update(payload).digest("base64url");
  return {
    create(input) {
      const exp = now() + ttlMs;
      const payload = b64url(JSON.stringify({ ...input, exp }));
      return { depositIntent: `v1.${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
    },
    verify(depositIntent) {
      const parts = depositIntent.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const expected = sign(parts[1]);
      const actual = Buffer.from(parts[2]);
      const signature = Buffer.from(expected);
      if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) return null;
      let payload: DepositIntentPayload & { exp?: number };
      try {
        payload = JSON.parse(fromB64url(parts[1]));
      } catch {
        return null;
      }
      if (!payload.userId || !payload.wallet || !payload.txBase64 || typeof payload.amountCents !== "number") return null;
      if (typeof payload.exp !== "number" || payload.exp <= now()) return null;
      return {
        userId: payload.userId,
        wallet: payload.wallet,
        amountCents: payload.amountCents,
        txBase64: payload.txBase64,
      };
    },
  };
}
