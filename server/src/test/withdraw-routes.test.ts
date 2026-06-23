import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("POST /v1/withdraw", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 withdrawals_disabled when withdrawals are off (default harness)", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "withdrawals_disabled" });
  });

  it("returns 200 with the withdrawalId + state on a successful reserve", async () => {
    ctx = await makeTestDb({ withdrawals: { async reserve() { return { status: "ok", withdrawalId: "w1", state: "awaiting_approval" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ withdrawalId: "w1", state: "awaiting_approval" });
  });

  it("returns 409 with the reserve status on a non-ok reserve", async () => {
    ctx = await makeTestDb({ withdrawals: { async reserve() { return { status: "capped" }; } } });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/withdraw", headers: H, payload: { amountCents: 100 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "capped" });
  });
});

describe("POST /v1/admin/withdraw/:id/approve", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns 404 when no withdrawProcessor is wired (default harness)", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/admin/withdraw/00000000-0000-0000-0000-000000000000/approve",
      headers: { "x-dev-user": "mallory" },
    });
    expect(res.statusCode).toBe(404);
  });
});
