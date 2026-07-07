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
