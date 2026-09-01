import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { feedAssetKeys } from "./symbols.js";
import type { PriceFeed } from "./types.js";

const PUMP_INTERVAL_MS = 250;

/** Wire format — the client is already built against exactly these two shapes. */
export type FeedMessage =
  | { type: "tick"; symbol: string; price: number; tsUs: number }
  | { type: "stale"; symbol: string };

export interface FeedBroadcaster {
  pump(): void;
}

export interface FeedSocketGateway {
  stop(): void;
}

interface WebSocketRouteRegistrar {
  get(
    path: string,
    options: { websocket: true },
    handler: (socket: WebSocket) => void,
  ): FastifyInstance;
}

/**
 * Pure per-pump diffing: one JSON message per asset whose publish_time advanced.
 *
 * Held apart from the socket plumbing so the interesting half — "did this asset actually move,
 * and have we already told everyone it went dark?" — is testable with a fake feed and no ws.
 */
export function makeFeedBroadcaster(deps: {
  feed: PriceFeed;
  assets: string[];
  send: (msg: string) => void;
}): FeedBroadcaster {
  const lastTs: Record<string, number> = {};
  const staleSent: Record<string, boolean> = {};
  return {
    pump() {
      for (const symbol of deps.assets) {
        if (!deps.feed.healthy(symbol)) {
          // one stale per outage, not one per pump — the flag resets when the feed comes back
          if (!staleSent[symbol]) {
            staleSent[symbol] = true;
            deps.send(JSON.stringify({ type: "stale", symbol } satisfies FeedMessage));
          }
          continue;
        }
        staleSent[symbol] = false;
        let tick;
        try {
          tick = deps.feed.current(symbol);
        } catch {
          continue; // healthy but nothing landed yet — skip this asset, never the whole list
        }
        if (lastTs[symbol] === tick.tsUs) continue;
        lastTs[symbol] = tick.tsUs;
        deps.send(JSON.stringify({ type: "tick", symbol, price: tick.price, tsUs: tick.tsUs } satisfies FeedMessage));
      }
    },
  };
}

/**
 * GET /v1/feed — read-only price fan-out. Every client gets the full current snapshot on connect,
 * then rides one shared pumped stream (the JSON is serialized once per tick, not once per client).
 * There is no subscribe frame: the server decides the symbol set, the client just listens.
 */
export function registerFeedSocket(
  server: FastifyInstance,
  deps: { feed: PriceFeed; assets?: string[]; intervalMs?: number },
): FeedSocketGateway {
  const assets = deps.assets ?? feedAssetKeys();
  const sockets = new Set<WebSocket>();

  function fanOut(msg: string): void {
    for (const socket of [...sockets]) {
      if (socket.readyState !== WebSocket.OPEN) {
        sockets.delete(socket);
        continue;
      }
      try {
        socket.send(msg);
      } catch {
        sockets.delete(socket); // slow or broken client: drop it, never stall the pump
      }
    }
  }

  const broadcaster = makeFeedBroadcaster({ feed: deps.feed, assets, send: fanOut });

  const timer = setInterval(() => {
    if (sockets.size === 0) return;
    broadcaster.pump();
  }, deps.intervalMs ?? PUMP_INTERVAL_MS);
  // never hold a test server (or a shutting-down process) open on the pump alone
  (timer as unknown as { unref?: () => void }).unref?.();

  const socketRoutes = server as unknown as WebSocketRouteRegistrar;
  socketRoutes.get("/v1/feed", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      sockets.delete(socket);
      socket.terminate();
    });
    // snapshot: this client shouldn't have to wait for the next move to know where prices are
    for (const symbol of assets) {
      let msg: FeedMessage;
      if (!deps.feed.healthy(symbol)) msg = { type: "stale", symbol };
      else {
        try {
          const tick = deps.feed.current(symbol);
          msg = { type: "tick", symbol, price: tick.price, tsUs: tick.tsUs };
        } catch {
          continue; // healthy but no tick yet — nothing honest to say about this symbol
        }
      }
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        sockets.delete(socket);
        return;
      }
    }
  });

  return {
    stop() {
      clearInterval(timer);
      sockets.clear();
    },
  };
}
