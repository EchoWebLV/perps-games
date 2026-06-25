import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "mallory", "content-type": "application/json" };

describe("GET /v1/me", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("accepts an anonymous session Bearer token", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const session = await ctx.server.inject({ method: "POST", url: "/v1/session" });
    expect(session.statusCode).toBe(200);

    const res = await ctx.server.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${session.json().token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(session.json().userId);
  });

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
