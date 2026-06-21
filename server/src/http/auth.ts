import type { FastifyRequest, FastifyReply } from "fastify";
import type { Users } from "../services/users.js";
import type { PrivyAuth } from "../auth/privy.js";
import { AuthError } from "../auth/privy.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

// A dev name must be a tight identifier: 1-64 chars of [a-zA-Z0-9_-] only.
// This both rejects garbage AND structurally forbids a ':' — so a forged
// `dev:${name}` external id can never collide with the `privy:did:privy:...`
// namespace. The real client sends `web-<uuid>` which this allows.
const DEV_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RequireUserDeps {
  users: Users;
  devAuth: boolean;             // honor x-dev-user only when true
  privyAuth: PrivyAuth | null;  // null when Privy keys absent
}

/** Resolves req.userId from a Privy Bearer access-token OR a DEV_AUTH-gated x-dev-user header, else 401. */
export function makeRequireUser(deps: RequireUserDeps) {
  return async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (bearer) {
      // A presented Bearer must NEVER fall through to the weaker dev path: if
      // there is no Privy backend to verify it, reject outright (fail closed).
      if (!deps.privyAuth) { await reply.code(401).send({ error: "no_auth_backend" }); return; }
      let did: string;
      try { did = await deps.privyAuth.verifyAccessToken(bearer); }
      catch (e) {
        if (e instanceof AuthError) { await reply.code(401).send({ error: "invalid_token" }); return; }
        throw e;
      }
      const user = await deps.users.upsertByExternalId(`privy:${did}`);
      // capture the embedded Solana address once (first sight), then it's cached on the row
      if (!user.walletPublicKey) {
        const addr = await deps.privyAuth.fetchSolanaWallet(did);
        if (addr) { await deps.users.setWalletPublicKey(user.id, addr); }
      }
      req.userId = user.id;
      return;
    }

    if (deps.devAuth) {
      const dev = req.headers["x-dev-user"];
      const name = Array.isArray(dev) ? dev[0] : dev;
      // Validate before minting: a malformed name (too long, empty, or with a
      // disallowed char like ':') falls through to the final 401 — never a user.
      if (name && DEV_NAME_RE.test(name)) {
        req.userId = (await deps.users.upsertByExternalId(`dev:${name}`)).id;
        return;
      }
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}
