import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Users } from "../services/users.js";

export interface SessionAuth {
  issueAnonymous(): Promise<{ token: string; userId: string }>;
  issueForUser(userId: string): Promise<{ token: string; userId: string }>;
  verifyToken(token: string): Promise<string | null>;
}

export interface SessionAuthDeps {
  users: Users;
  secret: string;
  now?: () => number;
  ttlMs?: number;
}

const enc = new TextEncoder();
const b64url = (buf: Uint8Array | string) =>
  Buffer.from(typeof buf === "string" ? enc.encode(buf) : buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeSessionAuth(deps: SessionAuthDeps): SessionAuth {
  if (deps.secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 1000 * 60 * 60 * 24 * 30;
  const issueForUser = async (userId: string) => {
    const payload = b64url(JSON.stringify({ sub: userId, exp: now() + ttlMs }));
    return { token: `v1.${payload}.${sign(deps.secret, payload)}`, userId };
  };

  return {
    async issueAnonymous() {
      const user = await deps.users.upsertByExternalId(`anon:${randomUUID()}`);
      return issueForUser(user.id);
    },
    issueForUser,
    async verifyToken(token) {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;

      const expected = sign(deps.secret, parts[1]);
      const a = Buffer.from(parts[2]);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

      let payload: { sub?: string; exp?: number };
      try {
        payload = JSON.parse(fromB64url(parts[1]));
      } catch {
        return null;
      }
      if (!payload.sub || typeof payload.exp !== "number" || payload.exp <= now()) return null;
      return payload.sub;
    },
  };
}
