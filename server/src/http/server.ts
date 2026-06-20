import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes, type RouteDeps } from "./routes.js";

export type ServerDeps = RouteDeps & { corsOrigins: string[] };

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  server.register(cors, {
    origin: deps.corsOrigins,
    allowedHeaders: ["x-dev-user", "content-type", "authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  });
  server.get("/healthz", async () => ({ ok: true }));
  registerRoutes(server, deps);
  return server;
}
