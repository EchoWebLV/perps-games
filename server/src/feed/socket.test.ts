import { describe, expect, it, afterEach, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeFeedBroadcaster, registerFeedSocket, type FeedSocketDeps } from "./socket.js";

const fakeFeed = (price: number, tsUs: number, healthy = true) => ({
  current: () => ({ price, tsUs }),
  healthy: () => healthy,
});

/**
 * Stand-in for a `ws` peer: records what was written, whether it was pinged, and whether it was
 * terminated. `bufferedAmount` is settable because that — not a throw — is how the real ws reports
 * a consumer that has stopped draining.
 */
class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  pings = 0;
  terminated = 0;
  sendThrows = false;
  private handlers = new Map<string, Array<() => void>>();
  on(event: string, fn: () => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  fire(event: string): void {
    for (const fn of this.handlers.get(event) ?? []) fn();
  }
  send(msg: string): void {
    if (this.sendThrows) throw new Error("socket is gone");
    this.sent.push(msg);
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  /** message `type`s written so far, in order. */
  types(): string[] {
    return this.sent.map((s) => JSON.parse(s).type as string);
  }
}

/** Registers the real gateway against a fake route registrar so fake peers can be handed to it. */
function harness(deps: FeedSocketDeps) {
  let onConnect: ((socket: WebSocket) => void) | undefined;
  const registrar = {
    get(_path: string, _opts: unknown, handler: (socket: WebSocket) => void) {
      onConnect = handler;
      return registrar;
    },
  };
  const gateway = registerFeedSocket(registrar as never, deps);
  return {
    gateway,
    connect(socket: FakeSocket): FakeSocket {
      onConnect!(socket as unknown as WebSocket);
      return socket;
    },
  };
}

/** A feed whose tsUs the test drives by hand. */
function steppableFeed(start = 1_000) {
  const state = { tsUs: start, price: 100, healthy: true };
  let currentCalls = 0;
  return {
    state,
    get currentCalls() {
      return currentCalls;
    },
    feed: {
      current: () => {
        currentCalls += 1;
        return { price: state.price, tsUs: state.tsUs };
      },
      healthy: () => state.healthy,
    },
  };
}

describe("makeFeedBroadcaster", () => {
  it("broadcasts a tick per asset only when publish_time advances", () => {
    const sent: string[] = [];
    const feed = { current: (a: string) => ({ price: a === "BTC" ? 50000 : 3000, tsUs: 111 }), healthy: () => true };
    const b = makeFeedBroadcaster({ feed: feed as never, assets: ["BTC", "ETH"], send: (msg) => sent.push(msg) });
    b.pump();
    expect(sent.map((s) => JSON.parse(s).symbol).sort()).toEqual(["BTC", "ETH"]);
    b.pump(); // same tsUs → nothing new
    expect(sent.length).toBe(2);
  });

  it("skips unhealthy assets and marks them stale once", () => {
    const sent: string[] = [];
    const b = makeFeedBroadcaster({ feed: fakeFeed(1, 1, false) as never, assets: ["BTC"], send: (m) => sent.push(m) });
    b.pump();
    expect(JSON.parse(sent[0])).toEqual({ type: "stale", symbol: "BTC" });
  });

  it("sends stale once per outage, not once per pump", () => {
    const sent: string[] = [];
    const b = makeFeedBroadcaster({ feed: fakeFeed(1, 1, false) as never, assets: ["BTC"], send: (m) => sent.push(m) });
    b.pump();
    b.pump();
    b.pump();
    expect(sent.length).toBe(1);
  });

  it("resumes ticks — and can re-stale — after the feed recovers", () => {
    const sent: string[] = [];
    let healthy = false;
    let tsUs = 1_000;
    const feed = { current: () => ({ price: 42, tsUs }), healthy: () => healthy };
    const b = makeFeedBroadcaster({ feed: feed as never, assets: ["BTC"], send: (m) => sent.push(m) });
    b.pump();                                   // stale
    healthy = true;
    b.pump();                                   // tick
    tsUs = 2_000;
    b.pump();                                   // tick (advanced)
    healthy = false;
    b.pump();                                   // stale again — the outage is new
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["stale", "tick", "tick", "stale"]);
  });

  it("emits the exact client-contract tick payload", () => {
    const sent: string[] = [];
    const b = makeFeedBroadcaster({
      feed: fakeFeed(50_123.5, 1_725_000_000_000_000) as never,
      assets: ["BTC"],
      send: (m) => sent.push(m),
    });
    b.pump();
    expect(JSON.parse(sent[0])).toEqual({ type: "tick", symbol: "BTC", price: 50_123.5, tsUs: 1_725_000_000_000_000 });
  });

  it("an asset with no tick yet never blocks the rest of the list", () => {
    const sent: string[] = [];
    const feed = {
      current: (a: string) => {
        if (a === "BTC") throw new Error("no tick for BTC");
        return { price: 3_000, tsUs: 7 };
      },
      healthy: () => true,
    };
    const b = makeFeedBroadcaster({ feed: feed as never, assets: ["BTC", "ETH"], send: (m) => sent.push(m) });
    b.pump();
    expect(sent.map((m) => JSON.parse(m).symbol)).toEqual(["ETH"]);
  });

  it("never re-sends a publish_time that went backwards", () => {
    const sent: string[] = [];
    let tsUs = 2_000;
    const feed = { current: () => ({ price: 42, tsUs }), healthy: () => true };
    const b = makeFeedBroadcaster({ feed: feed as never, assets: ["BTC"], send: (m) => sent.push(m) });
    b.pump();                                   // tick @2000
    tsUs = 1_000;                               // an out-of-order republish
    b.pump();
    tsUs = 2_000;                               // and back to what we already sent
    b.pump();
    expect(sent.length).toBe(1);
    tsUs = 2_001;
    b.pump();                                   // genuinely newer → through
    expect(sent.length).toBe(2);
  });

  it("treats a symbol named like an Object.prototype key as an ordinary symbol", () => {
    const sent: string[] = [];
    const b = makeFeedBroadcaster({
      feed: fakeFeed(1, 1, false) as never,
      assets: ["constructor"],
      send: (m) => sent.push(m),
    });
    b.pump();
    expect(JSON.parse(sent[0])).toEqual({ type: "stale", symbol: "constructor" });
  });

  it("heartbeats once the wire has been quiet and nothing on the table is healthy", () => {
    const sent: string[] = [];
    let clock = 0;
    const b = makeFeedBroadcaster({
      feed: fakeFeed(1, 1, false) as never,
      assets: ["BTC"],
      send: (m) => sent.push(m),
      now: () => clock,
      hbQuietMs: 750,
    });
    b.pump();                                   // stale (a real frame — resets the quiet window)
    clock += 500;
    b.pump();
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["stale"]);
    clock += 500;                               // 1000ms since the stale frame
    b.pump();
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["stale", "hb"]);
    clock += 750;
    b.pump();
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["stale", "hb", "hb"]);
  });

  it("stays silent while any symbol is healthy — the /v1/prices backstop still has a price to serve", () => {
    const sent: string[] = [];
    let clock = 0;
    // healthy, but publish_time frozen: exactly the 'slow symbol' shape. /v1/prices still answers
    // for this asset, so the client's poll is doing real work and must NOT be muzzled.
    const b = makeFeedBroadcaster({
      feed: fakeFeed(42, 7) as never,
      assets: ["BTC"],
      send: (m) => sent.push(m),
      now: () => clock,
      hbQuietMs: 750,
    });
    for (let i = 0; i < 20; i++) {
      b.pump();
      clock += 250;
    }
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["tick"]);
  });

  it("a fresh tick resets the quiet window", () => {
    const sent: string[] = [];
    let clock = 0;
    let healthy = false;
    let tsUs = 1;
    const feed = { current: () => ({ price: 5, tsUs }), healthy: () => healthy };
    const b = makeFeedBroadcaster({
      feed: feed as never,
      assets: ["BTC"],
      send: (m) => sent.push(m),
      now: () => clock,
      hbQuietMs: 750,
    });
    b.pump();                                   // stale
    clock += 800;
    b.pump();                                   // hb
    healthy = true;
    tsUs = 2;
    clock += 250;
    b.pump();                                   // tick
    healthy = false;
    clock += 500;                               // 500ms since the tick — under the window
    b.pump();                                   // stale (the outage is new)
    clock += 500;
    b.pump();                                   // 500ms since the stale frame — still under
    expect(sent.map((m) => JSON.parse(m).type)).toEqual(["stale", "hb", "tick", "stale"]);
  });
});

describe("registerFeedSocket fan-out", () => {
  afterEach(() => vi.useRealTimers());

  const INTERVAL = 250;

  it("hands every client the same frame and serializes it once per pump, not once per client", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({ feed: src.feed as never, assets: ["BTC", "ETH"], intervalMs: INTERVAL });
    const a = h.connect(new FakeSocket());
    const b = h.connect(new FakeSocket());
    const c = h.connect(new FakeSocket());
    const beforePump = src.currentCalls;

    src.state.tsUs = 2_000;
    vi.advanceTimersByTime(INTERVAL);

    // two assets, three clients: the feed is read twice, not six times
    expect(src.currentCalls - beforePump).toBe(2);
    expect(a.sent.length).toBe(4); // 2 snapshot frames on connect + 1 pumped tick per asset
    expect(b.sent).toEqual(a.sent);
    expect(c.sent).toEqual(a.sent);
    h.gateway.stop();
  });

  it("drops a socket that is no longer OPEN instead of writing to it", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({ feed: src.feed as never, assets: ["BTC"], intervalMs: INTERVAL });
    const dead = h.connect(new FakeSocket());
    const alive = h.connect(new FakeSocket());
    const dropped = dead.sent.length;
    dead.readyState = WebSocket.CLOSED;

    src.state.tsUs = 2_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(dead.sent.length).toBe(dropped);
    expect(alive.types()).toEqual(["tick", "tick"]);
    h.gateway.stop();
  });

  it("evicts a throwing socket without aborting the pump or poisoning the next one", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({ feed: src.feed as never, assets: ["BTC"], intervalMs: INTERVAL });
    const bad = h.connect(new FakeSocket());
    const good = h.connect(new FakeSocket());
    bad.sendThrows = true;

    src.state.tsUs = 2_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(good.types()).toEqual(["tick", "tick"]);
    expect(bad.terminated).toBe(1);

    src.state.tsUs = 3_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(good.types()).toEqual(["tick", "tick", "tick"]); // later pumps still land
    expect(bad.terminated).toBe(1);                          // and the evicted peer is gone for good
    h.gateway.stop();
  });

  it("evicts a socket whose outbound buffer blows past the ceiling", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({
      feed: src.feed as never,
      assets: ["BTC"],
      intervalMs: INTERVAL,
      maxBufferedBytes: 1_000,
    });
    const stuck = h.connect(new FakeSocket());
    const slowButOk = h.connect(new FakeSocket());
    const frozen = stuck.sent.length;
    stuck.bufferedAmount = 1_001;
    slowButOk.bufferedAmount = 999;

    src.state.tsUs = 2_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(stuck.sent.length).toBe(frozen);
    expect(stuck.terminated).toBe(1);
    expect(slowButOk.types()).toEqual(["tick", "tick"]);
    h.gateway.stop();
  });

  it("hands a dark symbol's stale frame to a client on connect", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    src.state.healthy = false;
    const h = harness({ feed: src.feed as never, assets: ["BTC"], intervalMs: INTERVAL });
    const s = h.connect(new FakeSocket());
    expect(JSON.parse(s.sent[0])).toEqual({ type: "stale", symbol: "BTC" });
    h.gateway.stop();
  });

  it("pings on the heartbeat interval and terminates a peer that never pongs", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({
      feed: src.feed as never,
      assets: ["BTC"],
      intervalMs: INTERVAL,
      heartbeatIntervalMs: 15_000,
    });
    // a half-open peer: still OPEN, never fires 'close', never answers
    const zombie = h.connect(new FakeSocket());

    vi.advanceTimersByTime(15_000);
    expect(zombie.pings).toBe(1);
    expect(zombie.terminated).toBe(0);

    vi.advanceTimersByTime(15_000);              // no pong came back in between
    expect(zombie.terminated).toBe(1);

    const frozen = zombie.sent.length;
    src.state.tsUs = 9_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(zombie.sent.length).toBe(frozen);     // and the pump no longer writes to it
    h.gateway.stop();
  });

  it("keeps a peer that pongs", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({
      feed: src.feed as never,
      assets: ["BTC"],
      intervalMs: INTERVAL,
      heartbeatIntervalMs: 15_000,
    });
    const s = h.connect(new FakeSocket());

    vi.advanceTimersByTime(15_000);
    s.fire("pong");
    vi.advanceTimersByTime(15_000);
    s.fire("pong");
    vi.advanceTimersByTime(15_000);
    expect(s.terminated).toBe(0);
    expect(s.pings).toBe(3);

    src.state.tsUs = 9_000;
    vi.advanceTimersByTime(INTERVAL);
    expect(s.types()).toEqual(["tick", "tick", "tick"]); // snapshot, first pump, post-heartbeat pump
    h.gateway.stop();
  });

  it("terminates a peer whose ping throws", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({
      feed: src.feed as never,
      assets: ["BTC"],
      intervalMs: INTERVAL,
      heartbeatIntervalMs: 15_000,
    });
    const s = h.connect(new FakeSocket());
    s.ping = () => {
      throw new Error("ping on a destroyed socket");
    };
    vi.advanceTimersByTime(15_000);
    expect(s.terminated).toBe(1);
    h.gateway.stop();
  });

  it("stop() closes the sockets it was holding and stops pumping", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    const h = harness({ feed: src.feed as never, assets: ["BTC"], intervalMs: INTERVAL });
    const a = h.connect(new FakeSocket());
    const b = h.connect(new FakeSocket());

    h.gateway.stop();
    expect(a.terminated).toBe(1);
    expect(b.terminated).toBe(1);

    const frozen = a.sent.length;
    src.state.tsUs = 4_000;
    vi.advanceTimersByTime(INTERVAL * 4);
    expect(a.sent.length).toBe(frozen);
  });

  it("broadcasts the heartbeat frame to every client while the table is dark", () => {
    vi.useFakeTimers();
    const src = steppableFeed();
    src.state.healthy = false;
    const h = harness({ feed: src.feed as never, assets: ["BTC"], intervalMs: INTERVAL });
    const a = h.connect(new FakeSocket());
    const b = h.connect(new FakeSocket());

    vi.advanceTimersByTime(INTERVAL);            // stale
    vi.advanceTimersByTime(1_000);               // wire quiet past the window → hb
    expect(a.types()).toEqual(["stale", "stale", "hb"]);
    expect(b.types()).toEqual(["stale", "stale", "hb"]);
    h.gateway.stop();
  });
});

describe("GET /v1/feed", () => {
  const contexts: TestCtx[] = [];
  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()!.server.close();
  });

  function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("message", (raw: RawData) => {
        try {
          resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  it("hands a new client the current snapshot with no subscribe frame", async () => {
    const ctx = await makeTestDb();
    contexts.push(ctx);
    ctx.feed.set("BTC", { price: 64_000, tsUs: 1_725_000_000_000_000 });
    await ctx.server.ready();

    const socket = await (ctx.server as typeof ctx.server & {
      injectWS(path: string): Promise<WebSocket>;
    }).injectWS("/v1/feed");
    const first = await nextJson(socket);
    socket.terminate();

    expect(first).toEqual({ type: "tick", symbol: "BTC", price: 64_000, tsUs: 1_725_000_000_000_000 });
  });
});
