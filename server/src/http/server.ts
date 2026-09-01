import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerFeedSocket } from "../feed/socket.js";
import { feedAssetKeys } from "../feed/symbols.js";
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
  /** symbols /v1/feed fans out; defaults to the whole symbol table */
  feedAssets?: string[];
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
    const feedGateway = registerFeedSocket(routes, {
      feed: deps.feed,
      assets: deps.feedAssets ?? feedAssetKeys(),
    });
    routes.addHook("onClose", async () => feedGateway.stop());
    routes.get("/healthz", async () => ({ ok: true }));
    registerRoutes(routes, deps);
  });
  return server;
}
