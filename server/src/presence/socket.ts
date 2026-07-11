import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import type { SessionAuth } from "../auth/session.js";
import type { Users } from "../services/users.js";
import { parseClientMessage, type ServerError, type ServerMessage } from "./protocol.js";
import type { PresenceRoom } from "./room.js";

const SNAPSHOT_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_BAD_MESSAGES = 3;

export interface PresenceSocketOptions {
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  snapshotIntervalMs?: number;
  heartbeatIntervalMs?: number;
  helloTimeoutMs?: number;
}

export interface PresenceSocketDeps extends PresenceSocketOptions {
  room: PresenceRoom;
  sessionAuth: SessionAuth;
  users: Users;
}

export interface PresenceSocketGateway {
  start(): void;
  stop(): void;
}

interface WebSocketRouteRegistrar {
  get(
    path: string,
    options: { websocket: true },
    handler: (socket: WebSocket) => void,
  ): FastifyInstance;
}

interface Connection {
  socket: WebSocket;
  memberId?: string;
  alive: boolean;
  closed: boolean;
  badMessages: number;
  helloTimer?: ReturnType<typeof setTimeout>;
}

export function registerPresenceSocket(server: FastifyInstance, deps: PresenceSocketDeps): PresenceSocketGateway {
  const now = deps.now ?? Date.now;
  const scheduleInterval = deps.setInterval ?? setInterval;
  const cancelInterval = deps.clearInterval ?? clearInterval;
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;
  const snapshotIntervalMs = deps.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const connections = new Set<Connection>();
  let snapshotTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function send(connection: Connection, message: ServerMessage): boolean {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return false;
    try {
      connection.socket.send(JSON.stringify(message));
      return true;
    } catch {
      cleanup(connection);
      connection.socket.terminate();
      return false;
    }
  }

  function cleanup(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.helloTimer !== undefined) {
      cancelTimeout(connection.helloTimer);
      connection.helloTimer = undefined;
    }
    if (connection.memberId !== undefined) {
      deps.room.leave(connection.memberId);
      connection.memberId = undefined;
    }
    connections.delete(connection);
  }

  function closeWithError(connection: Connection, code: ServerError["code"]): void {
    send(connection, { type: "error", code });
    cleanup(connection);
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(1008, code);
    else if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
  }

  function rejectBadMessage(connection: Connection): void {
    connection.badMessages += 1;
    if (connection.memberId === undefined || connection.badMessages >= MAX_BAD_MESSAGES) {
      closeWithError(connection, "bad_message");
      return;
    }
    send(connection, { type: "error", code: "bad_message" });
  }

  async function handleMessage(connection: Connection, raw: RawData): Promise<void> {
    if (connection.closed) return;
    const message = parseClientMessage(raw);
    if (message === null) {
      rejectBadMessage(connection);
      return;
    }

    if (connection.memberId === undefined) {
      if (message.type !== "hello") {
        closeWithError(connection, "bad_message");
        return;
      }
      if (connection.helloTimer !== undefined) {
        cancelTimeout(connection.helloTimer);
        connection.helloTimer = undefined;
      }

      const userId = await deps.sessionAuth.verifyToken(message.token);
      const user = userId === null ? undefined : await deps.users.get(userId);
      if (connection.closed) return;
      if (userId === null || user === undefined) {
        closeWithError(connection, "unauthorized");
        return;
      }

      const joined = deps.room.join(userId, message, (outbound) => send(connection, outbound));
      if (!joined.ok) {
        closeWithError(connection, joined.code);
        return;
      }
      connection.memberId = joined.id;
      send(connection, { type: "welcome", id: joined.id, serverTime: now() });
      return;
    }

    if (message.type === "hello") {
      rejectBadMessage(connection);
      return;
    }

    const result =
      message.type === "pose"
        ? deps.room.pose(connection.memberId, message, now())
        : deps.room.emote(connection.memberId, now());
    if (!result.ok) send(connection, { type: "error", code: result.code });
  }

  const socketRoutes = server as unknown as WebSocketRouteRegistrar;
  socketRoutes.get("/v1/presence", { websocket: true }, (socket) => {
    const connection: Connection = {
      socket,
      alive: true,
      closed: false,
      badMessages: 0,
    };
    connections.add(connection);

    let processing = Promise.resolve();
    socket.on("message", (raw) => {
      processing = processing
        .then(() => handleMessage(connection, raw))
        .catch(() => closeWithError(connection, "bad_message"));
    });
    socket.on("close", () => cleanup(connection));
    socket.on("error", () => {
      cleanup(connection);
      socket.terminate();
    });
    socket.on("pong", () => {
      connection.alive = true;
    });

    connection.helloTimer = scheduleTimeout(() => closeWithError(connection, "bad_message"), helloTimeoutMs);
  });

  return {
    start() {
      if (snapshotTimer !== undefined || heartbeatTimer !== undefined) return;
      snapshotTimer = scheduleInterval(() => deps.room.broadcastSnapshot(now()), snapshotIntervalMs);
      heartbeatTimer = scheduleInterval(() => {
        for (const connection of [...connections]) {
          if (!connection.alive) {
            cleanup(connection);
            connection.socket.terminate();
            continue;
          }
          connection.alive = false;
          try {
            connection.socket.ping();
          } catch {
            cleanup(connection);
            connection.socket.terminate();
          }
        }
      }, heartbeatIntervalMs);
    },

    stop() {
      if (snapshotTimer !== undefined) {
        cancelInterval(snapshotTimer);
        snapshotTimer = undefined;
      }
      if (heartbeatTimer !== undefined) {
        cancelInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      for (const connection of [...connections]) {
        cleanup(connection);
        connection.socket.terminate();
      }
    },
  };
}
