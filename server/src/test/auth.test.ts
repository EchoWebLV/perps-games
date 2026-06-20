import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb, type TestCtx } from "./harness.js";
import { makeRequireUser } from "../http/auth.js";

describe("requireUser (dev stub)", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  function appWithGuard() {
    const app = Fastify();
    const requireUser = makeRequireUser(ctx.users);
    app.get("/who", { preHandler: requireUser }, async (req) => ({ userId: req.userId }));
    return app;
  }

  it("401s without the header", async () => {
    const app = appWithGuard();
    const res = await app.inject({ method: "GET", url: "/who" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("resolves a stable userId from the header", async () => {
    const app = appWithGuard();
    const r1 = await app.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "alice" } });
    const r2 = await app.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "alice" } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().userId).toBe(r2.json().userId);
    await app.close();
  });
});
