import { afterEach, describe, expect, it, vi } from "vitest";
import { connectFeed, feedWsUrl, type FeedFetch } from "./feed";
import feedSource from "./feed.ts?raw";

/** Minimal stand-in for the browser WebSocket: records itself so a test can push frames. */
class FakeWs {
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(public url: string, public sink: FakeWs[]) { sink.push(this); }
  close() { this.closed = true; }
}

/** A ctor bound to one recording array, shaped like `typeof WebSocket` for the injection point. */
function fakeWsCtor(sockets: FakeWs[]) {
  return class extends FakeWs {
    constructor(url: string) { super(url, sockets); }
  } as unknown as typeof WebSocket;
}

function tick(symbol: string, price: number, tsUs = 1) {
  return { data: JSON.stringify({ type: "tick", symbol, price, tsUs }) };
}

/** A /v1/prices stand-in that always answers with the same payload, counting calls. */
function fakePrices(payload: unknown) {
  const calls: string[] = [];
  const impl: FeedFetch = (url) => { calls.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }); };
  return { impl, calls };
}

/** A fetch that never settles — models a server slower than the poll interval. */
function hangingFetch() {
  const calls: string[] = [];
  const impl: FeedFetch = (url) => { calls.push(url); return new Promise(() => {}); };
  return { impl, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe("feedWsUrl", () => {
  it("derives ws(s) from the API base", () => {
    expect(feedWsUrl("https://api.example.com")).toBe("wss://api.example.com/v1/feed");
    expect(feedWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/v1/feed");
  });
});

describe("connectFeed", () => {
  it("emits prices from server WS ticks", () => {
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });
    expect(sockets[0].url).toBe("ws://x/v1/feed");
    sockets[0].onmessage!(tick("BTC", 50000));
    expect(prices).toEqual([["BTC", 50000]]);
    h.stop();
  });

  it("ignores ticks for symbols the caller did not subscribe to", () => {
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });
    sockets[0].onmessage!(tick("DOGE", 1, 2));
    expect(prices).toEqual([]);
    h.stop();
  });

  it("marks the feed not-live on a stale message", () => {
    const sockets: FakeWs[] = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: () => {},
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });
    sockets[0].onmessage!(tick("BTC", 50000));
    expect(h.state.live).toBe(true);
    sockets[0].onmessage!({ data: JSON.stringify({ type: "stale", symbol: "BTC" }) });
    expect(h.state.live).toBe(false);
    h.stop();
  });

  it("closes the socket and stops reconnecting once stopped", () => {
    const sockets: FakeWs[] = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: () => {},
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });
    h.stop();
    expect(sockets[0].closed).toBe(true);
    sockets[0].onclose!();
    expect(sockets.length).toBe(1);
  });

  it("reconnects after the socket closes and resumes ticks", () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });
    sockets[0].onmessage!(tick("BTC", 50000));
    sockets[0].onclose!();
    expect(sockets.length).toBe(1);          // backoff not elapsed yet

    vi.advanceTimersByTime(400);             // first retry: 400ms
    expect(sockets.length).toBe(2);
    expect(sockets[1].url).toBe("ws://x/v1/feed");

    sockets[1].onmessage!(tick("BTC", 51000, 2));
    expect(prices).toEqual([["BTC", 50000], ["BTC", 51000]]);
    h.stop();
  });

  it("contains no Pyth endpoints or tokens", () => {
    expect(feedSource).not.toMatch(/dourolabs|hermes\.pyth|LAZER|ACCESS_TOKEN|H3BPYYS/);
  });
});

describe("connectFeed /v1/prices fallback", () => {
  it("polls the API once the WS has been silent past the grace window", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const server = fakePrices({ prices: { BTC: 50000 }, live: { BTC: true } });
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(server.calls).toEqual(["http://x/v1/prices"]);
    expect(prices).toEqual([["BTC", 50000]]);
    expect(h.state.live).toBe(true);
    h.stop();
  });

  it("skips assets the server omits as unhealthy", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const server = fakePrices({ prices: { BTC: 50000 }, live: { BTC: true, ETH: false } });
    const h = connectFeed({
      feeds: [{ key: "BTC" }, { key: "ETH" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(prices).toEqual([["BTC", 50000]]);   // ETH absent from `prices`, no throw
    h.stop();
  });

  // The poll's own delivery must not re-arm the WS-silence guard, or the effective
  // cadence doubles to ~1200ms exactly when the WS rail is down and the poll is all we have.
  it("keeps delivering every 600ms while the WS stays down", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const server = fakePrices({ prices: { BTC: 50000 }, live: { BTC: true } });
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(prices.length).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(prices.length).toBe(2);             // 600ms later, not 1200ms
    await vi.advanceTimersByTimeAsync(600);
    expect(prices.length).toBe(3);
    h.stop();
  });

  it("stays quiet while the WS is delivering, and takes over when it goes silent", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const server = fakePrices({ prices: { BTC: 50000 }, live: { BTC: true } });
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    sockets[0].onmessage!(tick("BTC", 49000));
    await vi.advanceTimersByTimeAsync(600);
    expect(server.calls).toEqual([]);          // WS is fresh — no poll

    await vi.advanceTimersByTimeAsync(1200);   // 1800ms of WS silence
    expect(server.calls.length).toBeGreaterThan(0);
    h.stop();
  });

  // The server sends `{type:"hb"}` on a dark table so a fleet of clients does not poll /v1/prices
  // forever for symbols the server would omit anyway. These two pin the client half of that
  // contract: the frame is inert as data, but it IS a sign of life on the rail.
  it("ignores an unknown frame type without emitting a price", () => {
    const sockets: FakeWs[] = [];
    const prices: Array<[string, number]> = [];
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: (k, v) => prices.push([k, v]),
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: hangingFetch().impl,
    });

    expect(() => sockets[0].onmessage!({ data: JSON.stringify({ type: "hb" }) })).not.toThrow();
    expect(prices).toEqual([]);
    expect(h.state.live).toBe(false);
    h.stop();
  });

  it("counts a heartbeat frame as WS liveness and holds the poll off", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const server = fakePrices({ prices: { BTC: 50000 }, live: { BTC: true } });
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: () => {},
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    sockets[0].onmessage!({ data: JSON.stringify({ type: "hb" }) });
    await vi.advanceTimersByTimeAsync(600);
    expect(server.calls).toEqual([]);          // without the hb this would already have polled

    await vi.advanceTimersByTimeAsync(1200);   // 1800ms since the hb — silence window elapsed
    expect(server.calls.length).toBeGreaterThan(0);
    h.stop();
  });

  it("does not stack requests when a poll outlives the interval", async () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const server = hangingFetch();
    const h = connectFeed({
      feeds: [{ key: "BTC" }],
      onPrice: () => {},
      wsCtor: fakeWsCtor(sockets),
      apiBase: "http://x",
      fetchImpl: server.impl,
    });

    await vi.advanceTimersByTimeAsync(1800);   // three interval ticks
    expect(server.calls.length).toBe(1);       // single-flight: the first is still open
    h.stop();
  });
});
