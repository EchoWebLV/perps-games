import Fastify, { type FastifyInstance } from "fastify";

export interface ServerDeps {
  // services are added in later tasks; empty for the healthz-only bootstrap
}

export function buildServer(_deps: ServerDeps = {}): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get("/healthz", async () => ({ ok: true }));
  return server;
}
