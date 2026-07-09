import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Users } from "../services/users.js";
import type { SessionAuth } from "../auth/session.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

const DEV_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RequireUserDeps {
  users: Users;
  devAuth: boolean;
  sessionAuth: SessionAuth;
}

export function makeRequireUser(deps: RequireUserDeps) {
  return async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (bearer) {
      const userId = await deps.sessionAuth.verifyToken(bearer);
      if (!userId) {
        await reply.code(401).send({ error: "invalid_token" });
        return;
      }
      const user = await deps.users.get(userId);
      if (!user) {
        await reply.code(401).send({ error: "invalid_token" });
        return;
      }
      req.userId = userId;
      return;
    }

    if (deps.devAuth) {
      const dev = req.headers["x-dev-user"];
      const name = Array.isArray(dev) ? dev[0] : dev;
      if (name && DEV_NAME_RE.test(name)) {
        req.userId = (await deps.users.upsertByExternalId(`dev:${name}`)).id;
        return;
      }
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}

/**
 * Like requireUser, but additionally requires the session to be WALLET-BOUND (user.walletPublicKey
 * set). Anonymous and un-bound sessions are rejected 403. Gates the economy-mutating endpoints so a
 * free anonymous session can't mint coins/scrap/cars (car ownership feeds real-payout perk params).
 * NOTE: this only closes the anonymous-mint surface — it does NOT make earning server-authoritative
 * (amounts are still client-supplied); bounding each game event server-side is separate, larger work.
 */
export function makeRequireWalletBoundUser(deps: RequireUserDeps) {
  const requireUser = makeRequireUser(deps);
  return async function requireWalletBoundUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireUser(req, reply);
    if (req.userId === undefined) return; // requireUser already rejected (401 sent); do not continue
    const user = await deps.users.get(req.userId);
    if (!user?.walletPublicKey) {
      await reply.code(403).send({ error: "wallet_required" });
    }
  };
}

/** constant-time secret compare (length-guarded; timingSafeEqual throws on unequal lengths). */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Guards the operator-only admin surface (e.g. withdrawal approval) with a shared secret sent in the
 * `x-admin-secret` header. Unset secret => the endpoint is DISABLED (404, no hint it exists); a
 * missing/wrong secret => 401. This is the production stand-in for the quorum/Intents co-signer.
 */
export function makeRequireAdmin(adminSecret: string | null) {
  return async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!adminSecret) {
      await reply.code(404).send({ error: "not_found" });
      return;
    }
    const hdr = req.headers["x-admin-secret"];
    const provided = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!provided || !secretsEqual(provided, adminSecret)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
  };
}
