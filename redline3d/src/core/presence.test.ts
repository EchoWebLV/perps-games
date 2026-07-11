import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "./auth";
import { apiBaseToWebSocket, createPresenceClient } from "./presence";

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

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
    this.sent.push(value);
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
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onSnapshot: (players, localId) => snapshots.push({ ids: players.map(({ id }) => id), localId }),
      onJoin: ({ id }) => joins.push(id),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();
    ws.message({ type: "welcome", id: "self", serverTime: 1 });
    ws.message({ type: "snapshot", players: [player("self"), player("p1")], serverTime: 2 });

    expect(snapshots).toEqual([{ ids: ["p1"], localId: "self" }]);
    expect(joins).toEqual(["p1"]);

    ws.message({
      type: "snapshot",
      players: [player("p2"), player("broken", { speed: undefined })],
      serverTime: 3,
    });
    expect(snapshots).toEqual([{ ids: ["p1"], localId: "self" }]);
    expect(joins).toEqual(["p1"]);
  });

  it("delivers only complete emote events", async () => {
    const emotes: unknown[] = [];
    const client = createPresenceClient({
      baseUrl: "https://api.example.com",
      auth: fakeAuth("token"),
      WebSocket: FakeWebSocket as never,
      name: () => "alice_1",
      carId: () => "Orion",
      onEmote: (event) => emotes.push(event),
    });
    client.connect();
    await flush();
    const ws = FakeWebSocket.only();
    ws.open();

    ws.message({ type: "emote", id: "p1", kind: "spark" });
    ws.message({ type: "emote", id: "p1", kind: "spark", nonce: 7 });

    expect(emotes).toEqual([{ id: "p1", kind: "spark", nonce: 7 }]);
  });

  it("sends spark emotes only while connected", async () => {
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
    client.emote();
    expect(ws.sent).toHaveLength(0);
    ws.open();
    client.emote();
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "emote", kind: "spark" });
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
    ws.close();
    client.disconnect();

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(snapshots).toEqual([["p1"], []]);
    expect(client.status()).toBe("offline");
  });
});
