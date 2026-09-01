import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { feedAssetKeys } from "./symbols.js";
import type { PriceFeed } from "./types.js";

const PUMP_INTERVAL_MS = 250;
/** ws-level ping cadence. A peer that misses one whole interval's pong is terminated (mirrors presence). */
const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * Application heartbeat: how long the wire may stay silent before an `hb` frame goes out.
 * Must sit comfortably under the client's 1200ms silence window (redline3d/src/core/feed.ts
 * SILENCE_MS) with room for pump granularity (250ms) and network latency — hence 750, not 1000.
 */
const HEARTBEAT_QUIET_MS = 750;
/**
 * Outbound backlog ceiling, bytes. A frame is ~70 bytes at 4Hz, so a peer reading at any usable
 * rate never accumulates 256KB; one that has is not draining and never will. `ws` buffers rather
 * than throwing, so this — not the send() catch — is what catches a stalled consumer.
 */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** Wire format — the client is already built against exactly these shapes. */
export type FeedMessage =
  | { type: "tick"; symbol: string; price: number; tsUs: number }
  | { type: "stale"; symbol: string }
  /**
   * Liveness only, no payload. Sent while the whole table is dark so clients can tell "the rail is
   * up, there is simply nothing to say" from "the rail is gone" — without that, every client falls
   * back to polling /v1/prices forever for symbols that endpoint omits anyway. The client ignores
   * unknown frame types but stamps its WS-liveness clock on any frame, so this needs no client change.
   */
  | { type: "hb" };

export interface FeedBroadcaster {
  pump(): void;
}

export interface FeedSocketGateway {
  stop(): void;
}

export interface FeedSocketDeps {
  feed: PriceFeed;
  assets?: string[];
  intervalMs?: number;
  heartbeatIntervalMs?: number;
  maxBufferedBytes?: number;
}

interface WebSocketRouteRegistrar {
  get(
    path: string,
    options: { websocket: true },
    handler: (socket: WebSocket) => void,
  ): FastifyInstance;
}

/** One live peer plus the flag the ws-level heartbeat reaps it by. */
interface Connection {
  socket: WebSocket;
  alive: boolean;
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
  /** Test seam for the heartbeat clock. */
  now?: () => number;
  hbQuietMs?: number;
}): FeedBroadcaster {
  const now = deps.now ?? Date.now;
  const hbQuietMs = deps.hbQuietMs ?? HEARTBEAT_QUIET_MS;
  // null-prototype: a symbol named "constructor"/"toString" would otherwise read its state off
  // Object.prototype — `staleSent["constructor"]` is truthy there, so a dark symbol with that name
  // would never get its stale frame. (The client did exactly this for the same reason.)
  const lastTs: Record<string, number> = Object.create(null);
  const staleSent: Record<string, boolean> = Object.create(null);
  const HEARTBEAT = JSON.stringify({ type: "hb" } satisfies FeedMessage);
  let lastSentAt = now();

  function send(msg: string): void {
    lastSentAt = now();
    deps.send(msg);
  }

  return {
    pump() {
      let anyHealthy = false;
      for (const symbol of deps.assets) {
        if (!deps.feed.healthy(symbol)) {
          // one stale per outage, not one per pump — the flag resets when the feed comes back
          if (!staleSent[symbol]) {
            staleSent[symbol] = true;
            send(JSON.stringify({ type: "stale", symbol } satisfies FeedMessage));
          }
          continue;
        }
        anyHealthy = true;
        staleSent[symbol] = false;
        let tick;
        try {
          tick = deps.feed.current(symbol);
        } catch {
          continue; // healthy but nothing landed yet — skip this asset, never the whole list
        }
        // advance-only: hermes already drops out-of-order publishes, but stating the rule here means
        // a rewound tsUs can never be replayed as news.
        const prev = lastTs[symbol];
        if (prev !== undefined && tick.tsUs <= prev) continue;
        lastTs[symbol] = tick.tsUs;
        send(JSON.stringify({ type: "tick", symbol, price: tick.price, tsUs: tick.tsUs } satisfies FeedMessage));
      }
      // Heartbeat ONLY while nothing on the table is healthy. With a healthy-but-frozen symbol the
      // client's /v1/prices poll is still fetching a real price and holding its own live() gate open,
      // so muzzling it there would block money rounds; with the table dark that endpoint omits every
      // symbol and the poll is pure noise.
      if (anyHealthy) return;
      if (now() - lastSentAt < hbQuietMs) return;
      send(HEARTBEAT);
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
  deps: FeedSocketDeps,
): FeedSocketGateway {
  const assets = deps.assets ?? feedAssetKeys();
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const maxBufferedBytes = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const connections = new Set<Connection>();

  function drop(connection: Connection): void {
    connections.delete(connection);
    connection.socket.terminate();
  }

  /** True iff the frame went out; false means the peer was evicted. */
  function writeTo(connection: Connection, msg: string): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      connections.delete(connection);
      return false;
    }
    // ws never throws for a slow consumer — it queues into bufferedAmount. A peer over the ceiling
    // is not reading at all (half-open radio, wedged tab), so evict it rather than grow the queue.
    if (connection.socket.bufferedAmount > maxBufferedBytes) {
      drop(connection);
      return false;
    }
    try {
      connection.socket.send(msg);
      return true;
    } catch {
      drop(connection); // send() only throws on an already-closed/destroyed socket
      return false;
    }
  }

  function fanOut(msg: string): void {
    for (const connection of [...connections]) writeTo(connection, msg);
  }

  const broadcaster = makeFeedBroadcaster({ feed: deps.feed, assets, send: fanOut });

  const timer = setInterval(() => {
    if (connections.size === 0) return;
    broadcaster.pump();
  }, deps.intervalMs ?? PUMP_INTERVAL_MS);

  // Liveness reaper. A peer whose radio dropped or whose NAT entry was evicted stays readyState
  // OPEN and never fires 'close'; without this the pump writes to it until the process restarts.
  const reaper = setInterval(() => {
    for (const connection of [...connections]) {
      if (!connection.alive) {
        drop(connection); // missed a whole interval's pong — half-open, gone
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        drop(connection);
      }
    }
  }, heartbeatIntervalMs);

  // never hold a test server (or a shutting-down process) open on the timers alone
  for (const t of [timer, reaper]) (t as unknown as { unref?: () => void }).unref?.();

  const socketRoutes = server as unknown as WebSocketRouteRegistrar;
  socketRoutes.get("/v1/feed", { websocket: true }, (socket) => {
    const connection: Connection = { socket, alive: true };
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
    socket.on("error", () => drop(connection));
    socket.on("pong", () => {
      connection.alive = true;
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
      if (!writeTo(connection, JSON.stringify(msg))) return;
    }
  });

  return {
    stop() {
      clearInterval(timer);
      clearInterval(reaper);
      for (const connection of [...connections]) drop(connection);
    },
  };
}
