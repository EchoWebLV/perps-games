import { describe, it, expect } from "vitest";
import { makeHermesFeed } from "./hermes.js";

const SOL_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// a fake Hermes endpoint that always returns 200 with SOL at $150 and a caller-controlled publish_time
function fakeFetch(publishTime: () => number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ parsed: [{ id: SOL_ID, price: { price: "15000000000", expo: -8, publish_time: publishTime() } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("makeHermesFeed health (advance-based, not absolute-age)", () => {
  it("is unhealthy until the first price arrives", () => {
    const feed = makeHermesFeed({ assets: ["SOL"], fetchImpl: fakeFetch(() => 0), now: () => 1_000_000 });
    expect(feed.healthy("SOL")).toBe(false);
  });

  it("stays HEALTHY while newer prices keep arriving, even with an 8s publish lag (the false-halt regression)", async () => {
    let nowMs = 1_000_000;
    let pubSec = Math.floor(nowMs / 1000) - 8; // publish_time always 8s behind wall-clock (> staleMs of 6s)
    const feed = makeHermesFeed({ assets: ["SOL"], staleMs: 6000, fetchImpl: fakeFetch(() => pubSec), now: () => nowMs });

    await feed.poll();
    expect(feed.healthy("SOL")).toBe(true);
    // wall clock + publish_time advance together: absolute age stays 8s, but a NEW price lands each poll
    for (let i = 0; i < 4; i++) { nowMs += 1000; pubSec += 1; await feed.poll(); }
    expect(feed.healthy("SOL")).toBe(true); // an absolute-age gate would have HALTed here — this must not
    expect(feed.current("SOL").price).toBeCloseTo(150);
  });

  it("ingests sub-second prices from the SSE stream (primary source)", async () => {
    const enc = new TextEncoder();
    const sse = (pubSec: number, priceStr: string) =>
      enc.encode(`data:${JSON.stringify({ parsed: [{ id: SOL_ID, price: { price: priceStr, expo: -8, publish_time: pubSec } }] })}\n\n`);
    const streamFetch = (async (url: any) => {
      if (String(url).includes("/stream")) {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(sse(1000, "15000000000")); // $150.00
            c.enqueue(sse(1001, "15123000000")); // $151.23 (advancing publish_time)
            // leave open: the loop parks on the next read until stop()
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ parsed: [] }), { status: 200 }); // REST backstop: no-op here
    }) as unknown as typeof fetch;

    let nowMs = 5_000_000;
    const feed = makeHermesFeed({ assets: ["SOL"], staleMs: 6000, fetchImpl: streamFetch, now: () => nowMs });
    feed.start();
    await new Promise((r) => setTimeout(r, 40)); // let the reader process both events
    expect(feed.current("SOL").price).toBeCloseTo(151.23);
    expect(feed.healthy("SOL")).toBe(true);
    feed.stop();
  });

  it("HALTs when publish_time stops advancing for longer than staleMs (a genuinely frozen feed)", async () => {
    let nowMs = 1_000_000;
    const frozenPub = Math.floor(nowMs / 1000) - 2;
    const feed = makeHermesFeed({ assets: ["SOL"], staleMs: 6000, fetchImpl: fakeFetch(() => frozenPub), now: () => nowMs });

    await feed.poll();
    expect(feed.healthy("SOL")).toBe(true);
    // endpoint keeps returning 200 but publish_time never advances; wall clock moves past staleMs
    for (let i = 0; i < 5; i++) { nowMs += 2000; await feed.poll(); } // +10s, no new price
    expect(feed.healthy("SOL")).toBe(false);
  });
});
