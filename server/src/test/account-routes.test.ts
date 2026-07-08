import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("GET /v1/me account state", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns coins, scrap, and cars with counts", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 40, "earn", "c1");
    await ctx.ledger.credit(userId, "scrap", 7, "scrap_earn", "s1");
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "orion");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coins).toBe(40);
    expect(body.scrap).toBe(7);
    expect(body.cars).toEqual([{ carId: "orion", count: 2, acquiredAt: expect.anything() }]);
  });
});

describe("coins earn/spend", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("earns coins (idempotent on ref) and spends them", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const earn = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 30, ref: "e1" } });
    expect(earn.statusCode).toBe(200);
    expect(earn.json().coins).toBe(30);
    // replay same ref → swallowed
    await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 30, ref: "e1" } });

    const spend = await ctx.server.inject({ method: "POST", url: "/v1/coins/spend", headers: H, payload: { amount: 12, ref: "s1" } });
    expect(spend.statusCode).toBe(200);
    expect(spend.json().coins).toBe(18);
  });

  it("402s when spending more coins than the balance", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/coins/spend", headers: H, payload: { amount: 5, ref: "x" } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_balance");
  });

  it("does not collide refs across different users", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const A = { "x-dev-user": "userA", "content-type": "application/json" };
    const B = { "x-dev-user": "userB", "content-type": "application/json" };
    const ra = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: A, payload: { amount: 20, ref: "shared" } });
    const rb = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: B, payload: { amount: 20, ref: "shared" } });
    expect(ra.json().coins).toBe(20);
    expect(rb.json().coins).toBe(20); // must NOT be swallowed by A's identical ref
  });
});

describe("scrap earn/spend", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("earns and spends scrap independently of coins", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const earn = await ctx.server.inject({ method: "POST", url: "/v1/scrap/earn", headers: H, payload: { amount: 5, ref: "se1" } });
    expect(earn.statusCode).toBe(200);
    expect(earn.json().scrap).toBe(5);

    const spend = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: H, payload: { amount: 2, ref: "ss1" } });
    expect(spend.statusCode).toBe(200);
    expect(spend.json().scrap).toBe(3);
  });

  it("402s when spending more scrap than the balance", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: H, payload: { amount: 9, ref: "z" } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_balance");
  });

  it("does not collide scrap refs across different users", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const A = { "x-dev-user": "scrapA", "content-type": "application/json" };
    const B = { "x-dev-user": "scrapB", "content-type": "application/json" };
    const ra = await ctx.server.inject({ method: "POST", url: "/v1/scrap/earn", headers: A, payload: { amount: 8, ref: "shared" } });
    const rb = await ctx.server.inject({ method: "POST", url: "/v1/scrap/earn", headers: B, payload: { amount: 8, ref: "shared" } });
    expect(ra.json().scrap).toBe(8);
    expect(rb.json().scrap).toBe(8); // must NOT be swallowed by A's identical ref
  });
});

describe("inventory grant/melt endpoints", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("grants (stacking) and melts (keep-last)", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const g1 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: H, payload: { carId: "orion" } });
    expect(g1.json()).toEqual({ carId: "orion", isNew: true, count: 1 });
    const g2 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: H, payload: { carId: "orion" } });
    expect(g2.json()).toEqual({ carId: "orion", isNew: false, count: 2 });

    const m1 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/melt", headers: H, payload: { carId: "orion" } });
    expect(m1.json()).toEqual({ carId: "orion", melted: true, count: 1 });
    const m2 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/melt", headers: H, payload: { carId: "orion" } });
    expect(m2.json()).toEqual({ carId: "orion", melted: false, count: 1 });
  });

  it("400s on a missing carId", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: H, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("coherence fixes", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("GET /v1/inventory includes the car count", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "orion");
    const res = await ctx.server.inject({ method: "GET", url: "/v1/inventory", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().cars).toEqual([{ carId: "orion", count: 2, acquiredAt: expect.anything() }]);
  });

  it("rejects an absurdly large earn amount", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 2_000_000_000, ref: "big" } });
    expect(res.statusCode).toBe(400);
  });
});
