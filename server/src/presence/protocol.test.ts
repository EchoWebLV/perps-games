import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  normalizePose,
  parseClientMessage,
  type ClientPose,
} from "./protocol.js";

describe("presence protocol", () => {
  it("accepts a strict Highway state advertisement", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "highway",
      asset: "SOL",
      roundPda: "Round1111111111111111111111111111111111",
      dir: 1,
      lev: 250,
      laneSeed: 2,
      carId: "Orion",
    }))).toMatchObject({ type: "highway", asset: "SOL", dir: 1, lev: 250 });
  });

  it("rejects malformed or client-wallet-bearing Highway advertisements", () => {
    const valid = {
      type: "highway", asset: "SOL", roundPda: "Round1111111111111111111111111111111111",
      dir: 1, lev: 250, laneSeed: 2, carId: "Orion",
    };
    expect(parseClientMessage(JSON.stringify({ ...valid, lev: 255 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...valid, laneSeed: 3 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...valid, wallet: "untrusted" }))).toBeNull();
  });

  it("parses a valid hello", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "hello",
          token: "session-token",
          name: "alice_1",
          carId: "Orion",
        }),
      ),
    ).toEqual({
      type: "hello",
      token: "session-token",
      name: "alice_1",
      carId: "Orion",
    });
  });

  it("rejects an invalid driver name", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "hello", token: "token", name: "Alice!", carId: "Orion" }),
      ),
    ).toBeNull();
  });

  it("rejects an unknown message type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat", text: "hello" }))).toBeNull();
  });

  it.each(["laugh", "fire", "skull"] as const)("parses the %s emote", (kind) => {
    expect(parseClientMessage(JSON.stringify({ type: "emote", kind }))).toEqual({
      type: "emote",
      kind,
    });
  });

  it("rejects legacy and unknown emotes", () => {
    expect(parseClientMessage(JSON.stringify({ type: "emote", kind: "spark" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "emote", kind: "wave" }))).toBeNull();
  });

  it("rejects a non-finite pose", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "pose",
          x: null,
          z: 0,
          heading: 0,
          speed: 0,
          carId: "Orion",
        }).replace('"x":null', '"x":1e999'),
      ),
    ).toBeNull();
  });

  it("normalizes a finite pose to lobby limits", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "pose",
        x: 999,
        z: -999,
        heading: Math.PI * 3,
        speed: 999,
        carId: "Orion",
      }),
    );
    expect(parsed?.type).toBe("pose");
    expect(normalizePose(parsed as ClientPose)).toEqual({
      x: 180,
      z: -180,
      heading: -Math.PI,
      speed: 28,
      carId: "Orion",
    });
  });

  it("clamps the opposite coordinate and speed limits", () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: "pose",
        x: -999,
        z: 999,
        heading: 0,
        speed: -10,
        carId: "Orion",
      }),
    );

    expect(normalizePose(parsed as ClientPose)).toMatchObject({ x: -180, z: 180, speed: 0 });
  });

  it("rejects a car id longer than 64 characters", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "pose",
          x: 0,
          z: 0,
          heading: 0,
          speed: 0,
          carId: "x".repeat(65),
        }),
      ),
    ).toBeNull();
  });

  it("rejects a message larger than the byte limit", () => {
    expect(parseClientMessage(" ".repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });
});
