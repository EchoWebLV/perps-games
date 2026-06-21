import type { FastifyRequest, FastifyReply } from "fastify";
import type { Users } from "../services/users.js";
import type { PrivyAuth } from "../auth/privy.js";
import { AuthError } from "../auth/privy.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

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

    if (bearer && deps.privyAuth) {
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
      if (name) { req.userId = (await deps.users.upsertByExternalId(`dev:${name}`)).id; return; }
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}
