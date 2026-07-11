import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import type { SessionAuth } from "../auth/session.js";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import type { ServerMessage } from "./protocol.js";

type TestOptions = Parameters<typeof makeTestDb>[0];

const sockets = new Set<WebSocket>();
const contexts: TestCtx[] = [];

async function setup(options: TestOptions = {}): Promise<TestCtx> {
  const ctx = await makeTestDb(options);
  contexts.push(ctx);
  await ctx.server.ready();
  return ctx;
}

async function connect(ctx: TestCtx): Promise<WebSocket> {
  const socket = await (ctx.server as typeof ctx.server & {
    injectWS(path: string): Promise<WebSocket>;
  }).injectWS("/v1/presence");
  sockets.add(socket);
  return socket;
}

function nextJson(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(raw.toString()) as ServerMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function nextClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function authenticate(ctx: TestCtx, name: string): Promise<{ socket: WebSocket; id: string }> {
  const { token } = await ctx.sessionAuth.issueAnonymous();
  const socket = await connect(ctx);
  const welcome = nextJson(socket);
  socket.send(JSON.stringify({ type: "hello", token, name, carId: "Orion" }));
  const message = await welcome;
  if (message.type !== "welcome") throw new Error(`expected welcome, got ${message.type}`);
  return { socket, id: message.id };
}

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState !== socket.CLOSED) socket.terminate();
  }
  sockets.clear();
  for (const ctx of contexts.splice(0).reverse()) await ctx.close();
});

describe("presence websocket", () => {
  it("authenticates in the first frame without URL credentials", async () => {
    const ctx = await setup();
    const { token } = await ctx.sessionAuth.issueAnonymous();
    const socket = await connect(ctx);
    expect("/v1/presence").not.toContain(token);
    expect(socket.url ?? "").not.toContain(token);
    const welcome = nextJson(socket);

    socket.send(JSON.stringify({ type: "hello", token, name: "alice_1", carId: "Orion" }));

    await expect(welcome).resolves.toMatchObject({ type: "welcome", id: expect.any(String) });
    socket.terminate();
  });

  it("rejects an invalid first-frame token", async () => {
    const ctx = await setup();
    const socket = await connect(ctx);
    const error = nextJson(socket);
    const closed = nextClose(socket);

    socket.send(JSON.stringify({ type: "hello", token: "invalid", name: "alice_1", carId: "Orion" }));

    await expect(error).resolves.toEqual({ type: "error", code: "unauthorized" });
    await closed;
  });

  it("rejects a ninth authenticated member when the room is full", async () => {
    const ctx = await setup();
    for (let index = 0; index < 8; index++) await authenticate(ctx, `rider_${index}`);

    const { token } = await ctx.sessionAuth.issueAnonymous();
    const ninth = await connect(ctx);
    const error = nextJson(ninth);
    const closed = nextClose(ninth);
    ninth.send(JSON.stringify({ type: "hello", token, name: "rider_9", carId: "Orion" }));

    await expect(error).resolves.toEqual({ type: "error", code: "lobby_full" });
    await closed;
  });

  it("applies poses to the next visual-only snapshot", async () => {
    const intervals = new Map<number, () => void>();
    const ctx = await setup({
      presenceSocketOptions: {
        now: () => 1_234,
        setInterval: ((callback: () => void, delay: number) => {
          intervals.set(delay, callback);
          return { delay } as unknown as NodeJS.Timeout;
        }) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
      },
    });
    const { socket, id } = await authenticate(ctx, "alice_1");
    const snapshot = nextJson(socket);

    socket.send(JSON.stringify({ type: "pose", x: 7, z: -8, heading: 0.5, speed: 12, carId: "Noodler" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    intervals.get(100)?.();

    await expect(snapshot).resolves.toEqual({
      type: "snapshot",
      players: [{ id, name: "alice_1", carId: "Noodler", x: 7, z: -8, heading: 0.5, speed: 12 }],
      serverTime: 1_234,
    });
  });

  it("removes room membership when a socket closes", async () => {
    const ctx = await setup();
    const { socket } = await authenticate(ctx, "alice_1");
    const closed = nextClose(socket);

    socket.terminate();
    await closed;

    await vi.waitFor(() => expect(ctx.presenceRoom.snapshot(0).players).toHaveLength(0));
  });

  it("rejects pose messages sent before hello", async () => {
    const ctx = await setup();
    const socket = await connect(ctx);
    const error = nextJson(socket);
    const closed = nextClose(socket);

    socket.send(JSON.stringify({ type: "pose", x: 0, z: 0, heading: 0, speed: 0, carId: "Orion" }));

    await expect(error).resolves.toEqual({ type: "error", code: "bad_message" });
    await closed;
  });

  it("requires hello within five seconds", async () => {
    let expireHello: (() => void) | undefined;
    const ctx = await setup({
      presenceSocketOptions: {
        setTimeout: ((callback: () => void, delay: number) => {
          if (delay === 5_000) expireHello = callback;
          return { delay } as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimeout: (() => undefined) as typeof clearTimeout,
      },
    });
    const socket = await connect(ctx);
    const error = nextJson(socket);
    const closed = nextClose(socket);

    expect(expireHello).toBeTypeOf("function");
    expireHello?.();

    await expect(error).resolves.toEqual({ type: "error", code: "bad_message" });
    await closed;
  });

  it("keeps the hello timeout active while token verification is pending", async () => {
    let expireHello: (() => void) | undefined;
    const cancelTimeout = vi.fn();
    const sessionAuth: SessionAuth = {
      issueAnonymous: async () => ({ token: "unused", userId: "unused" }),
      issueForUser: async (userId) => ({ token: "unused", userId }),
      verifyToken: () => new Promise<string | null>(() => undefined),
    };
    const ctx = await setup({
      sessionAuth,
      presenceSocketOptions: {
        setTimeout: ((callback: () => void, delay: number) => {
          if (delay === 5_000) expireHello = callback;
          return { delay } as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimeout: cancelTimeout as unknown as typeof clearTimeout,
      },
    });
    const socket = await connect(ctx);
    const error = nextJson(socket);
    const closed = nextClose(socket);

    socket.send(JSON.stringify({ type: "hello", token: "pending", name: "alice_1", carId: "Orion" }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cancelTimeout).not.toHaveBeenCalled();
    expireHello?.();
    await expect(error).resolves.toEqual({ type: "error", code: "bad_message" });
    await closed;
  });

  it("terminates heartbeat-dead sockets and removes their membership", async () => {
    let heartbeat: (() => void) | undefined;
    const ctx = await setup({
      presenceSocketOptions: {
        setInterval: ((callback: () => void, delay: number) => {
          if (delay === 15_000) heartbeat = callback;
          return { delay } as unknown as NodeJS.Timeout;
        }) as typeof setInterval,
        clearInterval: (() => undefined) as typeof clearInterval,
      },
    });
    const { socket } = await authenticate(ctx, "alice_1");
    const closed = nextClose(socket);
    (socket as WebSocket & { _autoPong: boolean })._autoPong = false;

    expect(heartbeat).toBeTypeOf("function");
    heartbeat?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    heartbeat?.();
    await closed;

    await vi.waitFor(() => expect(ctx.presenceRoom.snapshot(0).players).toHaveLength(0));
  });
});
