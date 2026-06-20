import type { FastifyRequest, FastifyReply } from "fastify";
import type { Users } from "../services/users.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * DEV auth seam. Resolves request.userId from the `x-dev-user` header by
 * upserting a `dev:<value>` user. Plan 1.3 replaces the body of this function
 * with Privy token verification (map the Privy DID to externalId) — the
 * preHandler contract (set request.userId or 401) stays identical.
 */
export function makeRequireUser(users: Users) {
  return async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const dev = req.headers["x-dev-user"];
    const name = Array.isArray(dev) ? dev[0] : dev;
    if (!name) {
      await reply.code(401).send({ error: "missing x-dev-user header" });
      return;
    }
    const user = await users.upsertByExternalId(`dev:${name}`);
    req.userId = user.id;
  };
}
