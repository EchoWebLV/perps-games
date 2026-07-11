import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "./auth";
import { apiBaseToWebSocket, createPresenceClient } from "./presence";
import type { PresenceClientOptions } from "./presence";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  private sendError: Error | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static only(): FakeWebSocket {
    expect(FakeWebSocket.instances).toHaveLength(1);
    return FakeWebSocket.instances[0]!;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    if (this.sendError !== null) {
      const error = this.sendError;
      this.sendError = null;
      throw error;
    }
    this.sent.push(value);
  }

  failNextSend(): void {
    this.sendError = new Error("fake send failed");
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function fakeAuth(token: string): AuthProvider {
  return {
    async ready() {},
    userId: () => "user-1",
    async authHeaders() {
      return { authorization: `Bearer ${token}` };
    },
  };
}

function clientOptions(overrides: Partial<PresenceClientOptions> = {}): PresenceClientOptions {
  return {
    baseUrl: "https://api.example.com",
    auth: fakeAuth("token"),
    WebSocket: FakeWebSocket as never,
    name: () => "alice_1",
    carId: () => "Orion",
    ...overrides,
  };
}

function player(id: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    name: `${id}_name`,
    carId: "Orion",
    x: 1,
    z: 2,
    heading: 0.25,
    speed: 3,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("presence client", () => {
  beforeEach(() => FakeWebSocket.reset());
  afterEach(() => vi.useRealTimers());

  it("converts HTTP API URLs to WebSocket URLs", () => {
    expect(apiBaseToWebSocket("http://api.example.com/")).toBe("ws://api.example.com/v1/presence");
    expect(apiBaseToWebSocket("https://api.example.com/base/")).toBe("wss://api.example.com/base/v1/presence");
  });

  it("sends auth in hello, never in the URL", async () => {
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("SECRET"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });

    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    expect(ws.url).toBe("wss://api.example.com/v1/presence");
    expect(ws.url).not.toContain("SECRET");
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "hello",
      token: "SECRET",
      name: "alice_1",
      carId: "Orion",
    });
  });

  it("sends a strict Highway advertisement without a client-supplied wallet", async () => {
    const client = createPresenceClient(clientOptions());
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    client.advertiseHighway({
      asset: "SOL", roundPda: "Round1111111111111111111111111111111111",
      dir: 1, lev: 250, laneSeed: 2, carId: "Orion",
    });
    expect(JSON.parse(ws.sent[ws.sent.length - 1]!)).toEqual({
      type: "highway", asset: "SOL", roundPda: "Round1111111111111111111111111111111111",
      dir: 1, lev: 250, laneSeed: 2, carId: "Orion",
    });
  });

  it("accepts wallet-bound Highway snapshot data and the 32-player render cap", async () => {
    const snapshots: unknown[] = [];
    const client = createPresenceClient(clientOptions({ onSnapshot: (players) => snapshots.push(players) }));
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    const players = Array.from({ length: 32 }, (_, i) => player(`p${i}`, i === 0 ? {
      highway: {
        wallet: "Wallet1111111111111111111111111111111111111",
        asset: "SOL", roundPda: "Round1111111111111111111111111111111111",
        dir: -1, lev: 150, laneSeed: 1, carId: "Orion",
      },
    } : {}));
    ws.message({ type: "snapshot", players, serverTime: 2 });
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any[])[0].highway).toMatchObject({ asset: "SOL", dir: -1, lev: 150 });
  });

  it("throttles pose updates to 100 ms and sends the latest pose", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "http://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();

    client.updatePose({ x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" });
    expect(ws.sent).toHaveLength(0);
    ws.open();
    client.updatePose({ x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" });
    client.updatePose({ x: 4, z: 5, heading: 0.2, speed: 6, carId: "Banana" });

    expect(ws.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "hello", token: "token", name: "alice_1", carId: "Orion" },
      { type: "pose", x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" },
    ]);
    await vi.advanceTimersByTimeAsync(99);
    expect(ws.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(ws.sent[2]!)).toEqual({
      type: "pose",
      x: 4,
      z: 5,
      heading: 0.2,
      speed: 6,
      carId: "Banana",
    });
  });

  it("becomes live only after a complete welcome message", async () => {
    const statuses: Array<[string, number]> = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onStatus: (status, count) => statuses.push([status, count]),
    });

    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    expect(client.status()).toBe("connecting");
    ws.message({ type: "welcome", id: "self" });
    expect(client.status()).toBe("connecting");
    ws.message({ type: "welcome", id: "self", serverTime: 10 });

    expect(client.status()).toBe("live");
    expect(statuses).toEqual([
      ["connecting", 0],
      ["live", 1],
    ]);
  });

  it("rejects a malformed snapshot atomically and filters the local player", async () => {
    const snapshots: Array<{ ids: string[]; localId: string | null }> = [];
    const joins: string[] = [];
    const leaves: string[] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onSnapshot: (players, localId) => snapshots.push({ ids: players.map(({ id }) => id), localId }),
      onJoin: ({ id }) => joins.push(id),
      onLeave: ({ id }) => leaves.push(id),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 2 });

    expect(snapshots).toEqual([{ ids: ["p1"], localId: "self" }]);
    expect(joins).toEqual(["p1"]);
    expect(leaves).toEqual([]);

    ws.message({
      type: "snapshot",
      players: [player("p2"), player("broken", { speed: undefined })],
      serverTime: 3,
    });
    expect(snapshots).toEqual([{ ids: ["p1"], localId: "self" }]);
    expect(joins).toEqual(["p1"]);
    expect(leaves).toEqual([]);

    ws.message({ type: "snapshot", players: [player("self"), player("p2")], serverTime: 4 });
    expect(snapshots).toEqual([
      { ids: ["p1"], localId: "self" },
      { ids: ["p2"], localId: "self" },
    ]);
    expect(joins).toEqual(["p1", "p2"]);
    expect(leaves).toEqual(["p1"]);
  });

  it("rejects legacy and unknown emote kinds", async () => {
    const emotes: unknown[] = [];
    const client = createPresenceClient(clientOptions({ onEmote: (event) => emotes.push(event) }));
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });

    ws.message({ type: "emote", id: "p1", kind: "spark", nonce: 1 });
    ws.message({ type: "emote", id: "p1", kind: "wave", nonce: 2 });
    expect(emotes).toEqual([]);
  });

  it("sends each selected emote kind", async () => {
    const client = createPresenceClient(clientOptions());
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    client.emote("laugh");
    client.emote("fire");
    client.emote("skull");
    expect(ws.sent.slice(1).map((frame) => JSON.parse(frame))).toEqual([
      { type: "emote", kind: "laugh" },
      { type: "emote", kind: "fire" },
      { type: "emote", kind: "skull" },
    ]);
  });

  it.each(["laugh", "fire", "skull"] as const)("delivers a complete %s event", async (kind) => {
    const emotes: unknown[] = [];
    const client = createPresenceClient(clientOptions({ onEmote: (event) => emotes.push(event) }));
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "emote", id: "p1", kind, nonce: 1 });
    expect(emotes).toEqual([{ id: "p1", kind, nonce: 1 }]);
  });

  it("delivers the welcome identity before a snapshot and rejects stale emote nonces", async () => {
    const delivered: Array<{ id: string; localId: string; nonce: number }> = [];
    const client = createPresenceClient(clientOptions({
      onEmote: (event, localId) => delivered.push({ id: event.id, localId, nonce: event.nonce }),
    }));
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });

    ws.message({ type: "emote", id: "self", kind: "laugh", nonce: 2 });
    ws.message({ type: "emote", id: "self", kind: "laugh", nonce: 2 });
    ws.message({ type: "emote", id: "self", kind: "fire", nonce: 1 });
    ws.message({ type: "emote", id: "self", kind: "skull", nonce: 3 });

    expect(delivered).toEqual([
      { id: "self", localId: "self", nonce: 2 },
      { id: "self", localId: "self", nonce: 3 },
    ]);
  });

  it("contains emote callback failures and continues processing messages", async () => {
    const emotes: string[] = [];
    const client = createPresenceClient(clientOptions({
      onEmote: ({ kind }) => {
        if (kind === "laugh") throw new Error("renderer failed");
        emotes.push(kind);
      },
    }));
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });

    expect(() => ws.message({ type: "emote", id: "p1", kind: "laugh", nonce: 1 })).not.toThrow();
    ws.message({ type: "emote", id: "p1", kind: "fire", nonce: 2 });

    expect(emotes).toEqual(["fire"]);
  });

  it("emits join and leave diffs without treating pose changes as joins", async () => {
    const joins: string[] = [];
    const leaves: Array<[string, number]> = [];
    const snapshots: string[][] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onSnapshot: (players) => snapshots.push(players.map(({ id }) => id)),
      onJoin: ({ id }) => joins.push(id),
      onLeave: ({ id, x }) => leaves.push([id, x]),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 2 });
    ws.message({
      type: "snapshot",
      players: [player("self"), player("p1", { x: 9 }), player("p2")],
      serverTime: 3,
    });
    ws.message({ type: "snapshot", players: [player("self"), player("p2")], serverTime: 4 });

    expect(snapshots).toEqual([["p1"], ["p1", "p2"], ["p2"]]);
    expect(joins).toEqual(["p1", "p2"]);
    expect(leaves).toEqual([["p1", 9]]);
  });

  it("reconnects after 500, 1000, 2000, then capped 5000 ms delays", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();

    for (const [index, delay] of [500, 1000, 2000, 5000, 5000].entries()) {
      FakeWebSocket.instances[index]!.close();
      await vi.advanceTimersByTimeAsync(delay - 1);
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
    }
  });

  it("reports offline while waiting to retry an unavailable server", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onStatus: (status) => statuses.push(status),
    });
    client.connect();
    await flush();

    FakeWebSocket.only().close();

    expect(client.status()).toBe("offline");
    expect(statuses).toEqual(["connecting", "offline"]);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("resets reconnect backoff after welcome", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    FakeWebSocket.instances[1]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const welcomed = FakeWebSocket.instances[2]!;
    welcomed.open();
    welcomed.message({ type: "welcome", id: "self", serverTime: 10 });
    welcomed.close();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("manual disconnect cancels reconnect and clears remote state", async () => {
    vi.useFakeTimers();
    const snapshots: string[][] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onSnapshot: (players) => snapshots.push(players.map(({ id }) => id)),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 2 });
    client.updatePose({ x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" });
    client.updatePose({ x: 4, z: 5, heading: 0.2, speed: 6, carId: "Banana" });
    expect(ws.sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    ws.close();
    expect(vi.getTimerCount()).toBe(1);
    client.disconnect();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent).toHaveLength(2);
    expect(snapshots).toEqual([["p1"], []]);
    expect(client.status()).toBe("offline");
  });

  it.each(["unauthorized", "lobby_full"] as const)(
    "treats %s as terminal until a future explicit connect",
    async (code) => {
      vi.useFakeTimers();
      const snapshots: string[][] = [];
      const errors: string[] = [];
      const invalidateSession = vi.fn();
      const client = createPresenceClient({
        baseUrl: "https://api.example.com",
        auth: { ...fakeAuth("token"), invalidateSession },
        WebSocket: FakeWebSocket as never,
        name: () => "alice_1",
        carId: () => "Orion",
        onSnapshot: (players) => snapshots.push(players.map(({ id }) => id)),
        onError: (errorCode) => errors.push(errorCode),
      });
      client.connect();
      await flush();
      const ws = FakeWebSocket.only();
      ws.open();
      ws.message({ type: "welcome", id: "self", serverTime: 1 });
      ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 2 });

      ws.message({ type: "error", code });
      ws.message({ type: "error", code });
      ws.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();

      expect(client.status()).toBe("offline");
      expect(errors).toEqual([code]);
      expect(invalidateSession).toHaveBeenCalledTimes(code === "unauthorized" ? 1 : 0);
      expect(snapshots).toEqual([["p1"], []]);
      expect(FakeWebSocket.instances).toHaveLength(1);

      client.connect();
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(2);
    },
  );

  it("contains a hello send failure and reconnects once", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.failNextSend();

    expect(() => ws.open()).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("contains a pose send failure and reconnects once", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.failNextSend();

    expect(() =>
      client.updatePose({ x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" }),
    ).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("contains an emote send failure and reconnects once", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.failNextSend();

    expect(() => client.emote("laugh")).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("contains a throttled pose send failure from the timer", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    client.updatePose({ x: 1, z: 2, heading: 0.1, speed: 3, carId: "Orion" });
    client.updatePose({ x: 4, z: 5, heading: 0.2, speed: 6, carId: "Banana" });
    ws.failNextSend();

    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores snapshots and emotes before welcome", async () => {
    const snapshots: string[][] = [];
    const joins: string[] = [];
    const emotes: unknown[] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onSnapshot: (players) => snapshots.push(players.map(({ id }) => id)),
      onJoin: ({ id }) => joins.push(id),
      onEmote: (event) => emotes.push(event),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();

    ws.message({ type: "snapshot", players: [player("p1")], serverTime: 1 });
    ws.message({ type: "emote", id: "p1", kind: "laugh", nonce: 1 });

    expect(client.status()).toBe("connecting");
    expect(snapshots).toEqual([]);
    expect(joins).toEqual([]);
    expect(emotes).toEqual([]);
  });

  it("ignores repeated welcome frames", async () => {
    const statuses: string[] = [];
    const snapshots: Array<{ ids: string[]; localId: string | null }> = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onStatus: (status) => statuses.push(status),
      onSnapshot: (players, localId) => snapshots.push({ ids: players.map(({ id }) => id), localId }),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "welcome", id: "replacement", serverTime: 2 });
    ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 3 });

    expect(statuses).toEqual(["connecting", "live", "live"]);
    expect(snapshots).toEqual([{ ids: ["p1"], localId: "self" }]);
  });

  it("ignores an asynchronous close from a stale socket after reconnect", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const oldSocket = FakeWebSocket.only();
    oldSocket.close();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);

    oldSocket.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("keeps nonfatal server errors contained", async () => {
    vi.useFakeTimers();
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });

    expect(() => ws.message({ type: "error", code: "bad_message" })).not.toThrow();
    expect(() => ws.message({ type: "error", code: "rate_limited" })).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.status()).toBe("live");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
