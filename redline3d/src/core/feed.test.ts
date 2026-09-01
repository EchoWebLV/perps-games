import { describe, expect, it } from "vitest";
import { connectFeed, feedWsUrl } from "./feed";
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
    });
    expect(sockets[0].url).toBe("ws://x/v1/feed");
    sockets[0].onmessage!({ data: JSON.stringify({ type: "tick", symbol: "BTC", price: 50000, tsUs: 1 }) });
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
    });
    sockets[0].onmessage!({ data: JSON.stringify({ type: "tick", symbol: "DOGE", price: 1, tsUs: 2 }) });
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
    });
    sockets[0].onmessage!({ data: JSON.stringify({ type: "tick", symbol: "BTC", price: 50000, tsUs: 1 }) });
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
    });
    h.stop();
    expect(sockets[0].closed).toBe(true);
    sockets[0].onclose!();
    expect(sockets.length).toBe(1);
  });

  it("contains no Pyth endpoints or tokens", () => {
    expect(feedSource).not.toMatch(/dourolabs|hermes\.pyth|LAZER|ACCESS_TOKEN|H3BPYYS/);
  });
});
