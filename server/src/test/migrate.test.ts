import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, bindDevWallet, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("POST /v1/migrate (seed-if-empty)", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("seeds an empty account from the local save", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seeded: true });

    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    const body = me.json();
    expect(body.coins).toBe(250);
    expect(body.scrap).toBe(30);
    expect(body.cars.find((c: any) => c.carId === "clowncar").count).toBe(2);
  });

  it("refuses to seed (and never sums) when the account already has state", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 500, "earn", "pre");

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 250, scrap: 30, cars: {} },
    });
    expect(res.json()).toEqual({ seeded: false, reason: "account_not_empty" });
    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(me.json().coins).toBe(500); // unchanged, not 750
  });

  it("rejects an oversized per-car count", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 0, scrap: 0, cars: { orion: 100000 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("seeds a cars-only save with zero coins and scrap", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 0, scrap: 0, cars: { orion: 2 } },
    });
    expect(res.json()).toEqual({ seeded: true });
    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    const body = me.json();
    expect(body.coins).toBe(0);
    expect(body.scrap).toBe(0);
    expect(body.cars.find((c: any) => c.carId === "orion").count).toBe(2);
  });
});
