import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("routes", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("GET /v1/balance is 0 for a new user", async () => {
    const res = await ctx.server.inject({ method: "GET", url: "/v1/balance", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ balance: 0 });
  });

  it("dev grant-coins increases the balance", async () => {
    await ctx.server.inject({ method: "POST", url: "/v1/dev/grant-coins", headers: H, payload: { amount: 250 } });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/balance", headers: H });
    expect(res.json()).toEqual({ balance: 250 });
  });

  it("dev grant-car shows up in inventory and /v1/me", async () => {
    await ctx.server.inject({ method: "POST", url: "/v1/dev/grant-car", headers: H, payload: { carId: "orion" } });
    const inv = await ctx.server.inject({ method: "GET", url: "/v1/inventory", headers: H });
    expect(inv.json().cars.map((c: any) => c.carId)).toEqual(["orion"]);

    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    const body = me.json();
    expect(body.cars.map((c: any) => c.carId)).toEqual(["orion"]);
    expect(body.userId).toBeTruthy();
  });

  it("401 without auth header", async () => {
    const res = await ctx.server.inject({ method: "GET", url: "/v1/balance" });
    expect(res.statusCode).toBe(401);
  });

  it("grant-coins rejects a non-positive amount", async () => {
    const res = await ctx.server.inject({ method: "POST", url: "/v1/dev/grant-coins", headers: H, payload: { amount: 0 } });
    expect(res.statusCode).toBe(400);
  });
});
