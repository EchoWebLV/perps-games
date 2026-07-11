import { describe, expect, it } from "vitest";
import type { ClientHello, ClientPose, ServerEmote, ServerSnapshot } from "./protocol.js";
import { makePresenceRoom, type PresenceSink } from "./room.js";

function hello(name = "rider_1", carId = "Orion"): ClientHello {
  return { type: "hello", token: "session-token", name, carId };
}

function pose(overrides: Partial<ClientPose> = {}): ClientPose {
  return {
    type: "pose",
    x: 1,
    z: 2,
    heading: 0.5,
    speed: 3,
    carId: "Orion",
    ...overrides,
  };
}

function sink(): { messages: Array<ServerSnapshot | ServerEmote>; send: PresenceSink } {
  const messages: Array<ServerSnapshot | ServerEmote> = [];
  return { messages, send: (message) => messages.push(message) };
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `p${++n}`;
}

describe("presence room", () => {
  it("caps the room at eight while keeping public ids distinct", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    for (let i = 0; i < 8; i++) {
      expect(room.join("same-private-user", hello(`rider_${i}`), sink().send).ok).toBe(true);
    }
    expect(room.join("ninth", hello("rider_9"), sink().send)).toEqual({
      ok: false,
      code: "lobby_full",
    });
    expect(room.snapshot(10).players.map((player) => player.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
      "p8",
    ]);
    expect(JSON.stringify(room.snapshot(10))).not.toContain("same-private-user");
  });

  it("removes a leaving member from the next snapshot", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const joined = room.join("private-user", hello(), sink().send);
    if (!joined.ok) throw new Error("expected join to succeed");

    room.leave(joined.id);

    expect(room.snapshot(20)).toEqual({ type: "snapshot", players: [], serverTime: 20 });
  });

  it("normalizes accepted poses before exposing them", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const joined = room.join("private-user", hello(), sink().send);
    if (!joined.ok) throw new Error("expected join to succeed");

    expect(
      room.pose(
        joined.id,
        pose({ x: 999, z: -999, heading: Math.PI * 3, speed: 999, carId: "Noodler" }),
        0,
      ),
    ).toEqual({ ok: true });
    expect(room.snapshot(30).players[0]).toEqual({
      id: "p1",
      name: "rider_1",
      carId: "Noodler",
      x: 180,
      z: -180,
      heading: -Math.PI,
      speed: 28,
    });
  });

  it("accepts at most fifteen poses in a sliding second", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const joined = room.join("private-user", hello(), sink().send);
    if (!joined.ok) throw new Error("expected join to succeed");

    for (let i = 0; i < 15; i++) {
      expect(room.pose(joined.id, pose({ x: i }), 0)).toEqual({ ok: true });
    }
    expect(room.pose(joined.id, pose({ x: 99 }), 999)).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect(room.pose(joined.id, pose({ x: 100 }), 1_000)).toEqual({ ok: true });
    expect(room.snapshot(1_000).players[0]?.x).toBe(100);
  });

  it("accepts at most two emotes in a sliding second", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const joined = room.join("private-user", hello(), sink().send);
    if (!joined.ok) throw new Error("expected join to succeed");

    expect(room.emote(joined.id, "fire", 0)).toEqual({ ok: true });
    expect(room.emote(joined.id, "fire", 0)).toEqual({ ok: true });
    expect(room.emote(joined.id, "fire", 999)).toEqual({ ok: false, code: "rate_limited" });
    expect(room.emote(joined.id, "fire", 1_000)).toEqual({ ok: true });
  });

  it("broadcasts accepted emotes with a fresh nonce", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const firstSink = sink();
    const secondSink = sink();
    const first = room.join("private-1", hello("rider_1"), firstSink.send);
    const second = room.join("private-2", hello("rider_2"), secondSink.send);
    if (!first.ok || !second.ok) throw new Error("expected joins to succeed");

    room.emote(first.id, "laugh", 0);
    room.emote(second.id, "skull", 1_000);

    expect(firstSink.messages).toEqual([
      { type: "emote", id: "p1", kind: "laugh", nonce: 1 },
      { type: "emote", id: "p2", kind: "skull", nonce: 2 },
    ]);
    expect(secondSink.messages).toEqual(firstSink.messages);
  });

  it("broadcasts newly constructed public snapshots", () => {
    const room = makePresenceRoom({ id: sequentialIds() });
    const recipient = sink();
    room.join("private-user", hello(), recipient.send);

    room.broadcastSnapshot(50);

    expect(recipient.messages).toEqual([
      {
        type: "snapshot",
        players: [
          {
            id: "p1",
            name: "rider_1",
            carId: "Orion",
            x: 0,
            z: 0,
            heading: 0,
            speed: 0,
          },
        ],
        serverTime: 50,
      },
    ]);
    expect(JSON.stringify(recipient.messages)).not.toContain("private-user");
  });
});
