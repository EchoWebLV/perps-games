import { randomUUID } from "node:crypto";
import {
  normalizePose,
  type ClientHighway,
  type ClientHello,
  type ClientPose,
  type PresenceEmoteKind,
  type PresenceHighway,
  type PresencePose,
  type PresencePlayer,
  type ServerEmote,
  type ServerSnapshot,
} from "./protocol.js";

const MAX_PLAYERS = 32;
const RATE_WINDOW_MS = 1_000;
const MAX_POSES_PER_WINDOW = 15;
const MAX_EMOTES_PER_WINDOW = 2;

export type PresenceBroadcast = ServerSnapshot | ServerEmote;
export type PresenceSink = (message: PresenceBroadcast) => void;
export type RateLimitResult = { ok: true } | { ok: false; code: "rate_limited" };
export type JoinResult = { ok: true; id: string } | { ok: false; code: "lobby_full" };

export interface PresenceRoom {
  join(userId: string, hello: ClientHello, sink: PresenceSink): JoinResult;
  leave(id: string): void;
  pose(id: string, pose: ClientPose, now: number): RateLimitResult;
  highway(id: string, wallet: string, state: ClientHighway): RateLimitResult;
  setIndexedHighways(positions: PresenceHighway[]): void;
  emote(id: string, kind: PresenceEmoteKind, now: number): RateLimitResult;
  snapshot(serverTime: number): ServerSnapshot;
  broadcastSnapshot(serverTime: number): void;
}

interface PresenceMember {
  id: string;
  userId: string;
  name: string;
  pose: PresencePose;
  sink: PresenceSink;
  poseTimes: number[];
  emoteTimes: number[];
  highway?: Omit<ClientHighway, "type"> & { wallet: string };
}

export interface PresenceRoomOptions {
  id?: () => string;
}

function withinRateLimit(timestamps: number[], now: number, limit: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  return true;
}

export function makePresenceRoom(options: PresenceRoomOptions = {}): PresenceRoom {
  const makeId = options.id ?? randomUUID;
  const members = new Map<string, PresenceMember>();
  let indexedHighways: PresenceHighway[] = [];
  let emoteNonce = 0;

  function nextPublicId(): string {
    const candidate = makeId();
    if (!members.has(candidate)) return candidate;

    let fallback = randomUUID();
    while (members.has(fallback)) fallback = randomUUID();
    return fallback;
  }

  return {
    join(userId, hello, sink) {
      if (members.size >= MAX_PLAYERS) return { ok: false, code: "lobby_full" };

      const id = nextPublicId();
      members.set(id, {
        id,
        userId,
        name: hello.name,
        pose: { x: 0, z: 0, heading: 0, speed: 0, carId: hello.carId },
        sink,
        poseTimes: [],
        emoteTimes: [],
      });
      return { ok: true, id };
    },

    leave(id) {
      members.delete(id);
    },

    pose(id, pose, now) {
      const member = members.get(id);
      if (!member || !withinRateLimit(member.poseTimes, now, MAX_POSES_PER_WINDOW)) {
        return { ok: false, code: "rate_limited" };
      }

      member.pose = normalizePose(pose);
      return { ok: true };
    },

    highway(id, wallet, state) {
      const member = members.get(id);
      if (!member) return { ok: false, code: "rate_limited" };
      member.highway = {
        wallet,
        asset: state.asset,
        roundPda: state.roundPda,
        dir: state.dir,
        lev: state.lev,
        laneSeed: state.laneSeed,
        carId: state.carId,
      };
      return { ok: true };
    },

    setIndexedHighways(positions) {
      indexedHighways = positions.map((position) => ({ ...position }));
    },

    emote(id, kind, now) {
      const member = members.get(id);
      if (!member || !withinRateLimit(member.emoteTimes, now, MAX_EMOTES_PER_WINDOW)) {
        return { ok: false, code: "rate_limited" };
      }

      const message: ServerEmote = {
        type: "emote",
        id: member.id,
        kind,
        nonce: ++emoteNonce,
      };
      for (const recipient of [...members.values()]) recipient.sink(message);
      return { ok: true };
    },

    snapshot(serverTime) {
      const indexedRoundPdas = new Set(indexedHighways.map((position) => position.roundPda));
      const indexedPlayers: PresencePlayer[] = indexedHighways.map((highway) => ({
        id: `chain:${highway.roundPda}`,
        name: `${highway.dir === 1 ? "long" : "short"}_${highway.roundPda.slice(0, 8)}`
          .toLowerCase()
          .slice(0, 16),
        carId: highway.carId,
        x: 0,
        z: 0,
        heading: 0,
        speed: 0,
        highway,
      }));
      const connectedPlayers: PresencePlayer[] = [...members.values()]
        .filter((member) => !member.highway || !indexedRoundPdas.has(member.highway.roundPda))
        .map((member) => ({
          id: member.id,
          name: member.name,
          carId: member.pose.carId,
          x: member.pose.x,
          z: member.pose.z,
          heading: member.pose.heading,
          speed: member.pose.speed,
          ...(member.highway ? { highway: member.highway } : {}),
        }));
      return {
        type: "snapshot",
        players: [...indexedPlayers, ...connectedPlayers].slice(0, MAX_PLAYERS),
        serverTime,
      };
    },

    broadcastSnapshot(serverTime) {
      for (const member of [...members.values()]) member.sink(this.snapshot(serverTime));
    },
  };
}
