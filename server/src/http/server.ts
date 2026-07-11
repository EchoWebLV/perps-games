import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { PresenceRoom } from "../presence/room.js";
import {
  registerPresenceSocket,
  type PresenceSocketOptions,
} from "../presence/socket.js";
import { registerRoutes, type RouteDeps } from "./routes.js";

export type ServerDeps = RouteDeps & {
  corsOrigins: string[];
  presenceRoom: PresenceRoom;
  presenceSocketOptions?: PresenceSocketOptions;
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  server.register(websocket, {
    options: { maxPayload: 2048, perMessageDeflate: false },
  });
  server.register(cors, {
    origin: deps.corsOrigins,
    allowedHeaders: ["x-dev-user", "x-trade-wallet", "content-type", "authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  });
  server.register(async (routes) => {
    const presenceGateway = registerPresenceSocket(routes, {
      room: deps.presenceRoom,
      sessionAuth: deps.sessionAuth,
      users: deps.users,
      ...deps.presenceSocketOptions,
    });
    presenceGateway.start();
    routes.addHook("onClose", async () => presenceGateway.stop());
    routes.get("/healthz", async () => ({ ok: true }));
    registerRoutes(routes, deps);
  });
  return server;
}
