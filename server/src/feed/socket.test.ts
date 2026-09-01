import { describe, expect, it, afterEach } from "vitest";
import type { RawData, WebSocket } from "ws";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeFeedBroadcaster } from "./socket.js";

const fakeFeed = (price: number, tsUs: number, healthy = true) => ({
  current: () => ({ price, tsUs }),
  healthy: () => healthy,
});

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
