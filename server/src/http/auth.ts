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
