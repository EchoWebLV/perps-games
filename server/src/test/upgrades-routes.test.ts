import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, bindDevWallet, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("GET /v1/me levels", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns zeroed levels for a fresh user", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().levels).toEqual({ turbo: 0, tank: 0, suspension: 0 });
  });
});

describe("POST /v1/upgrades/buy", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("debits the escalating cost, increments the level, and /v1/me reflects it", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 100, "dev_grant", "seed-coin");
    await ctx.ledger.credit(userId, "scrap", 100, "dev_grant", "seed");

    const res = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ track: "turbo", level: 1, coins: 80, scrap: 80 });

    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(me.json().levels.turbo).toBe(1);
  });

  it("403s without a wallet-bound session", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    // dev user "alice" exists (via header) but no wallet bound → economy mutation refused
    const res = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
    expect(res.statusCode).toBe(403);
  });

  it("402s when the player cannot afford the upgrade", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_balance");
  });

  it("409s at max level after ten buys", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 100000, "dev_grant", "seed-coin");
    await ctx.ledger.credit(userId, "scrap", 100000, "dev_grant", "seed");
    for (let i = 0; i < 10; i++) {
      const r = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
      expect(r.statusCode).toBe(200);
      expect(r.json().level).toBe(i + 1);
    }
    const r11 = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
    expect(r11.statusCode).toBe(409);
    expect(r11.json().error).toBe("max_level");
  });

  it("400s on a bad track", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "warp" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/migrate levels", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("seeds levels on an empty account and /v1/me reflects them", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 5, scrap: 0, cars: {}, levels: { turbo: 3, tank: 1, suspension: 2 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seeded: true });

    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(me.json().levels).toEqual({ turbo: 3, tank: 1, suspension: 2 });
  });

  it("refuses to seed when the only existing state is non-zero levels", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "alice");
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    // give the account a level via a real buy, then drain scrap back to zero via the spend route
    await ctx.ledger.credit(userId, "coin", 100, "dev_grant", "seed-coin");
    await ctx.ledger.credit(userId, "scrap", 100, "dev_grant", "seed");
    const buy = await ctx.server.inject({ method: "POST", url: "/v1/upgrades/buy", headers: H, payload: { track: "turbo" } });
    expect(buy.statusCode).toBe(200); // coins 80 + scrap 80, turbo 1
    const spendCoins = await ctx.server.inject({ method: "POST", url: "/v1/coins/spend", headers: H, payload: { amount: 80, ref: "drain-c" } });
    const spendScrap = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: H, payload: { amount: 80, ref: "drain" } });
    expect(spendCoins.statusCode).toBe(200);
    expect(spendScrap.statusCode).toBe(200);
    expect(spendCoins.json().coins).toBe(0);
    expect(spendScrap.json().scrap).toBe(0); // coins/scrap/cars all zero — the ONLY state is turbo=1

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 999, scrap: 0, cars: {}, levels: { turbo: 0, tank: 0, suspension: 0 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seeded: false, reason: "account_not_empty" });
  });
});

describe("earn rate cap", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("429s once the rolling earn ceiling is exceeded, independently per reason", async () => {
    ctx = await makeTestDb({ earnLimit: { ceiling: 50, windowMs: 60_000 } });
    await bindDevWallet(ctx, "alice");

    const e1 = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 40, ref: "e1" } });
    expect(e1.statusCode).toBe(200);

    const e2 = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 20, ref: "e2" } });
    expect(e2.statusCode).toBe(429);
    expect(e2.json().error).toBe("earn_rate_exceeded");

    // scrap earns draw from an independent budget (different ledger reason)
    const s1 = await ctx.server.inject({ method: "POST", url: "/v1/scrap/earn", headers: H, payload: { amount: 45, ref: "s1" } });
    expect(s1.statusCode).toBe(200);
  });
});
