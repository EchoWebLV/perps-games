import { z } from "zod";

export const MAX_MESSAGE_BYTES = 2048;
export const LOBBY_X = 120;
export const LOBBY_Z_MIN = -160;
export const LOBBY_Z_MAX = 160;
export const MAX_LOBBY_SPEED = 48;
export const NAME_RE = /^[a-z0-9_]{3,16}$/;
export const CAR_ID_RE = /^[\x20-\x7e]{1,64}$/;

const carIdSchema = z.string().regex(CAR_ID_RE);

const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      token: z.string().min(1),
      name: z.string().regex(NAME_RE),
      carId: carIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pose"),
      x: z.number().finite(),
      z: z.number().finite(),
      heading: z.number().finite(),
      speed: z.number().finite(),
      carId: carIdSchema,
    })
    .strict(),
  z.object({ type: z.literal("emote"), kind: z.literal("spark") }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientHello = Extract<ClientMessage, { type: "hello" }>;
export type ClientPose = Extract<ClientMessage, { type: "pose" }>;
export type ClientEmote = Extract<ClientMessage, { type: "emote" }>;

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

export interface ServerWelcome {
  type: "welcome";
  id: string;
  serverTime: number;
}

export interface ServerSnapshot {
  type: "snapshot";
  players: PresencePlayer[];
  serverTime: number;
}

export interface ServerEmote {
  type: "emote";
  id: string;
  kind: "spark";
  nonce: number;
}

export interface ServerError {
  type: "error";
  code: "unauthorized" | "lobby_full" | "bad_message" | "rate_limited";
}

export type ServerMessage = ServerWelcome | ServerSnapshot | ServerEmote | ServerError;

function decodeRawMessage(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return null;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const text = decodeRawMessage(raw);
  if (text === null || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    const result = clientMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHeading(heading: number): number {
  const turn = Math.PI * 2;
  return ((((heading + Math.PI) % turn) + turn) % turn) - Math.PI;
}

export function normalizePose(message: ClientPose): PresencePose {
  return {
    x: clamp(message.x, -LOBBY_X, LOBBY_X),
    z: clamp(message.z, LOBBY_Z_MIN, LOBBY_Z_MAX),
    heading: normalizeHeading(message.heading),
    speed: clamp(message.speed, 0, MAX_LOBBY_SPEED),
    carId: message.carId,
  };
}
