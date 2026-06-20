import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes, type RouteDeps } from "./routes.js";

export type ServerDeps = RouteDeps;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get("/healthz", async () => ({ ok: true }));
  registerRoutes(server, deps);
  return server;
}
