import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb, type TestCtx } from "./harness.js";
import { makeRequireUser } from "../http/auth.js";
import { makeSessionAuth, type SessionAuth } from "../auth/session.js";

describe("requireUser", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  function app(opts: { devAuth?: boolean; sessionAuth?: SessionAuth } = {}) {
    const a = Fastify();
    const requireUser = makeRequireUser({
      users: ctx.users,
      devAuth: opts.devAuth ?? true,
      sessionAuth: opts.sessionAuth ?? makeSessionAuth({
        users: ctx.users,
        secret: "test-session-secret-32-characters-long",
      }),
    });
    a.get("/who", { preHandler: requireUser }, async (req) => ({ userId: req.userId }));
    return a;
  }

  it("401s with no auth", async () => {
    const a = app(); const r = await a.inject({ method: "GET", url: "/who" });
    expect(r.statusCode).toBe(401); await a.close();
  });

  it("dev header resolves a stable user when DEV_AUTH on", async () => {
    const a = app({ devAuth: true });
    const r1 = await a.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "alice" } });
    const r2 = await a.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "alice" } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().userId).toBe(r2.json().userId);
    await a.close();
  });

  it("dev header is REJECTED (401) when DEV_AUTH off", async () => {
    const a = app({ devAuth: false });
    const r = await a.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "alice" } });
    expect(r.statusCode).toBe(401); await a.close();
  });

  it("valid session Bearer resolves the session user", async () => {
    const sessionAuth = makeSessionAuth({ users: ctx.users, secret: "test-session-secret-32-characters-long" });
    const issued = await sessionAuth.issueAnonymous();
    const a = app({ sessionAuth });
    const r = await a.inject({ method: "GET", url: "/who", headers: { authorization: `Bearer ${issued.token}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(issued.userId);
    await a.close();
  });

  it("invalid Bearer does not fall through to dev auth", async () => {
    const a = app({ devAuth: true });
    const r = await a.inject({
      method: "GET",
      url: "/who",
      headers: { authorization: "Bearer invalid", "x-dev-user": "alice" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("invalid_token");
    await a.close();
  });

  it("namespace isolation: x-dev-user 'did:wallet:abc' is REJECTED 401 (colon fails validation)", async () => {
    const a = app({ devAuth: true });
    const r = await a.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "did:wallet:abc" } });
    expect(r.statusCode).toBe(401);
    await a.close();
  });

  it("dev name validation (Fix B): too-long or colon-containing → 401; web-<uuid> → 200", async () => {
    const a = app({ devAuth: true });

    const tooLong = await a.inject({
      method: "GET",
      url: "/who",
      headers: { "x-dev-user": "a".repeat(100) },
    });
    expect(tooLong.statusCode).toBe(401);

    const withColon = await a.inject({
      method: "GET",
      url: "/who",
      headers: { "x-dev-user": "foo:bar" },
    });
    expect(withColon.statusCode).toBe(401);

    const ok = await a.inject({
      method: "GET",
      url: "/who",
      headers: { "x-dev-user": "web-550e8400-e29b-41d4-a716-446655440000" },
    });
    expect(ok.statusCode).toBe(200);
    const user = await ctx.users.get(ok.json().userId);
    expect(user!.externalId).toBe("dev:web-550e8400-e29b-41d4-a716-446655440000");

    await a.close();
  });
});
