import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("GET /v1/me", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns openRoundId: null when no round is open", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().openRoundId).toBeNull();
  });

  it("with the faucet ON, seeds a new user exactly once", async () => {
    ctx = await makeTestDb({ signupFaucet: true, startBalance: 100 });
    const a = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(a.json().balance).toBe(100);
    const b = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(b.json().balance).toBe(100); // idempotent — not re-seeded
  });

  it("with the faucet OFF, a new user has balance 0", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(res.json().balance).toBe(0);
  });
});
