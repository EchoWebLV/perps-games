import type { AuthProvider } from "./auth";

export type PresenceStatus = "offline" | "connecting" | "live";

export interface PresencePose {
  x: number;
  z: number;
  heading: number;
  speed: number;
  carId: string;
}

export interface PresencePlayer extends PresencePose {
  id: string;
  name: string;
}

export type RemotePresencePlayer = PresencePlayer;

export const PRESENCE_EMOTE_KINDS = ["laugh", "fire", "skull"] as const;
export type PresenceEmoteKind = (typeof PRESENCE_EMOTE_KINDS)[number];

export interface PresenceEmote {
  id: string;
  kind: PresenceEmoteKind;
  nonce: number;
}

interface SocketEvent {
  data?: unknown;
}

interface SocketLike {
  readonly readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: SocketEvent) => void): void;
  send(value: string): void;
  close(): void;
}

interface SocketConstructor {
  new (url: string): SocketLike;
}

interface WelcomeMessage {
  type: "welcome";
  id: string;
  serverTime: number;
}

interface SnapshotMessage {
  type: "snapshot";
  players: PresencePlayer[];
  serverTime: number;
}

type ServerErrorCode = "unauthorized" | "lobby_full" | "bad_message" | "rate_limited";

interface ErrorMessage {
  type: "error";
  code: ServerErrorCode;
}

type ParsedServerMessage = WelcomeMessage | SnapshotMessage | (PresenceEmote & { type: "emote" }) | ErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isEmoteKind(value: unknown): value is PresenceEmoteKind {
  return value === "laugh" || value === "fire" || value === "skull";
}

function parsePlayer(value: unknown): PresencePlayer | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["id", "name", "carId", "x", "z", "heading", "speed"])) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || !/^[a-z0-9_]{3,16}$/.test(value.name)) return null;
  if (typeof value.carId !== "string" || !/^[\x20-\x7e]{1,64}$/.test(value.carId)) return null;
  if (
    typeof value.x !== "number" ||
    typeof value.z !== "number" ||
    typeof value.heading !== "number" ||
    typeof value.speed !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.z) ||
    !Number.isFinite(value.heading) ||
    !Number.isFinite(value.speed)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    carId: value.carId,
    x: value.x,
    z: value.z,
    heading: value.heading,
    speed: value.speed,
  };
}

function parseServerMessage(raw: unknown): ParsedServerMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (value.type === "welcome") {
      if (!hasExactKeys(value, ["type", "id", "serverTime"])) return null;
      if (typeof value.id !== "string" || value.id.length === 0) return null;
      if (typeof value.serverTime !== "number" || !Number.isFinite(value.serverTime)) return null;
      return { type: "welcome", id: value.id, serverTime: value.serverTime };
    }
    if (value.type === "snapshot") {
      if (!hasExactKeys(value, ["type", "players", "serverTime"])) return null;
      if (!Array.isArray(value.players) || value.players.length > 8) return null;
      if (typeof value.serverTime !== "number" || !Number.isFinite(value.serverTime)) return null;
      const players: PresencePlayer[] = [];
      const ids = new Set<string>();
      for (const candidate of value.players) {
        const player = parsePlayer(candidate);
        if (player === null || ids.has(player.id)) return null;
        players.push(player);
        ids.add(player.id);
      }
      return { type: "snapshot", players, serverTime: value.serverTime };
    }
    if (value.type === "emote") {
      if (!hasExactKeys(value, ["type", "id", "kind", "nonce"])) return null;
      if (typeof value.id !== "string" || value.id.length === 0 || !isEmoteKind(value.kind)) return null;
      if (typeof value.nonce !== "number" || !Number.isSafeInteger(value.nonce) || value.nonce < 1) return null;
      return { type: "emote", id: value.id, kind: value.kind, nonce: value.nonce };
    }
    if (value.type === "error") {
      if (!hasExactKeys(value, ["type", "code"])) return null;
      if (
        value.code !== "unauthorized" &&
        value.code !== "lobby_full" &&
        value.code !== "bad_message" &&
        value.code !== "rate_limited"
      ) {
        return null;
      }
      return { type: "error", code: value.code };
    }
    return null;
  } catch {
    return null;
  }
}

export interface PresenceClientOptions {
  baseUrl: string;
  auth: AuthProvider;
  WebSocket?: SocketConstructor;
  name: () => string;
  carId: () => string;
  onSnapshot?: (players: PresencePlayer[], localId: string | null) => void;
  onJoin?: (player: PresencePlayer) => void;
  onLeave?: (player: PresencePlayer) => void;
  onEmote?: (event: PresenceEmote) => void;
  onStatus?: (status: PresenceStatus, count: number) => void;
  onError?: (code: "unauthorized" | "lobby_full") => void;
}

export interface PresenceClient {
  connect(): void;
  disconnect(): void;
  updatePose(pose: PresencePose): void;
  emote(kind: PresenceEmoteKind): void;
  status(): PresenceStatus;
}

export function apiBaseToWebSocket(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error("Presence API base URL must use http or https");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/presence`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function bearerToken(headers: Record<string, string>): string | null {
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function createPresenceClient(options: PresenceClientOptions): PresenceClient {
  const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as SocketConstructor);
  let desired = false;
  let generation = 0;
  let socket: SocketLike | null = null;
  let currentStatus: PresenceStatus = "offline";
  let localId: string | null = null;
  let players = new Map<string, PresencePlayer>();
  let lastPoseSentAt = Number.NEGATIVE_INFINITY;
  let pendingPose: PresencePose | null = null;
  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const reconnectDelays = [500, 1000, 2000, 5000] as const;

  function clearPoseQueue(): void {
    pendingPose = null;
    if (poseTimer !== null) clearTimeout(poseTimer);
    poseTimer = null;
    lastPoseSentAt = Number.NEGATIVE_INFINITY;
  }

  function clearRemoteState(): void {
    const hadState = players.size > 0 || localId !== null;
    players = new Map();
    localId = null;
    if (hadState) options.onSnapshot?.([], null);
  }

  function scheduleReconnect(myGeneration: number): void {
    if (!desired || myGeneration !== generation) return;
    if (currentStatus !== "offline") {
      currentStatus = "offline";
      options.onStatus?.("offline", 0);
    }
    if (reconnectTimer !== null) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openSocket(myGeneration);
    }, delay);
  }

  function reconnectAfterLoss(next: SocketLike, myGeneration: number, closeTransport = false): void {
    if (!desired || myGeneration !== generation || socket !== next) return;
    socket = null;
    clearPoseQueue();
    clearRemoteState();
    if (closeTransport) {
      try {
        next.close();
      } catch {
        // Local teardown and reconnect scheduling still proceed.
      }
    }
    scheduleReconnect(myGeneration);
  }

  function sendPose(): void {
    poseTimer = null;
    const next = socket;
    if (next?.readyState !== 1 || pendingPose === null) return;
    const pose = pendingPose;
    pendingPose = null;
    try {
      next.send(JSON.stringify({ type: "pose", ...pose }));
    } catch {
      reconnectAfterLoss(next, generation, true);
      return;
    }
    lastPoseSentAt = Date.now();
  }

  function queuePose(pose: PresencePose): void {
    if (socket?.readyState !== 1) return;
    pendingPose = pose;
    const wait = Math.max(0, 100 - (Date.now() - lastPoseSentAt));
    if (wait === 0) sendPose();
    else if (poseTimer === null) poseTimer = setTimeout(sendPose, wait);
  }

  async function openSocket(myGeneration: number): Promise<void> {
    let token: string | null;
    try {
      token = bearerToken(await options.auth.authHeaders());
    } catch {
      scheduleReconnect(myGeneration);
      return;
    }
    if (!desired || myGeneration !== generation) return;
    if (token === null) {
      desired = false;
      currentStatus = "offline";
      options.onStatus?.("offline", 0);
      return;
    }

    let next: SocketLike;
    try {
      next = new Socket(apiBaseToWebSocket(options.baseUrl));
    } catch {
      scheduleReconnect(myGeneration);
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (!desired || myGeneration !== generation || socket !== next) return;
      try {
        next.send(JSON.stringify({ type: "hello", token, name: options.name(), carId: options.carId() }));
      } catch {
        reconnectAfterLoss(next, myGeneration, true);
      }
    });
    next.addEventListener("message", (event) => {
      if (!desired || myGeneration !== generation || socket !== next) return;
      const message = parseServerMessage(event.data);
      if (message === null) return;
      if (message.type === "welcome") {
        if (localId !== null || currentStatus === "live") return;
        localId = message.id;
        reconnectAttempt = 0;
        currentStatus = "live";
        options.onStatus?.("live", 1);
        return;
      }
      if (message.type === "error") {
        if (message.code === "bad_message" || message.code === "rate_limited") return;
        desired = false;
        generation += 1;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        socket = null;
        clearPoseQueue();
        clearRemoteState();
        currentStatus = "offline";
        options.onStatus?.("offline", 0);
        try {
          next.close();
        } catch {
          // The connection is already terminal locally.
        }
        if (message.code === "unauthorized") {
          try {
            options.auth.invalidateSession?.();
          } catch {
            // The next explicit lobby entry can still retry the provider.
          }
        }
        try {
          options.onError?.(message.code);
        } catch {
          // Presence feedback is best-effort and cannot block local play.
        }
        return;
      }
      if (localId === null || currentStatus !== "live") return;
      if (message.type === "emote") {
        try {
          options.onEmote?.({ id: message.id, kind: message.kind, nonce: message.nonce });
        } catch {
          // Presence visuals are best-effort and cannot block local play.
        }
        return;
      }

      const remotePlayers = message.players.filter(({ id }) => id !== localId);
      const nextPlayers = new Map(remotePlayers.map((player) => [player.id, player]));
      const joined = remotePlayers.filter(({ id }) => !players.has(id));
      const left = [...players.values()].filter(({ id }) => !nextPlayers.has(id));
      players = nextPlayers;
      options.onSnapshot?.(remotePlayers, localId);
      for (const player of joined) options.onJoin?.(player);
      for (const player of left) options.onLeave?.(player);
      options.onStatus?.(currentStatus, message.players.length);
    });
    next.addEventListener("close", () => {
      reconnectAfterLoss(next, myGeneration);
    });
  }

  return {
    connect() {
      if (desired) return;
      desired = true;
      currentStatus = "connecting";
      options.onStatus?.("connecting", 0);
      const myGeneration = ++generation;
      void openSocket(myGeneration);
    },
    disconnect() {
      desired = false;
      generation += 1;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = 0;
      socket?.close();
      socket = null;
      clearPoseQueue();
      clearRemoteState();
      currentStatus = "offline";
      options.onStatus?.("offline", 0);
    },
    updatePose(pose) {
      queuePose(pose);
    },
    emote(kind) {
      const next = socket;
      if (next?.readyState !== 1) return;
      try {
        next.send(JSON.stringify({ type: "emote", kind }));
      } catch {
        reconnectAfterLoss(next, generation, true);
      }
    },
    status() {
      return currentStatus;
    },
  };
}
