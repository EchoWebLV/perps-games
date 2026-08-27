import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("GET /v1/prices", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("is public and omits assets that have no healthy tick", async () => {
    const res = await ctx.server.inject({ method: "GET", url: "/v1/prices" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      prices: {},
      live: { BTC: false, ETH: false, SOL: false },
    });
  });

  it("returns the stub feed's healthy ticks", async () => {
    ctx.feed.set("SOL", { price: 172.5, tsUs: 1_000_000 });
    ctx.feed.set("BTC", { price: 65000, tsUs: 1_000_000 });
    ctx.feed.setHealthy("BTC", false);

    const res = await ctx.server.inject({ method: "GET", url: "/v1/prices" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      prices: { SOL: 172.5 },
      live: { BTC: false, ETH: false, SOL: true },
    });
  });
});
