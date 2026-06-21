import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { makeTestDb, type TestCtx } from "./harness.js";
import { makeRequireUser } from "../http/auth.js";
import type { PrivyAuth } from "../auth/privy.js";
import { AuthError } from "../auth/privy.js";

function fakePrivy(): PrivyAuth & { fetchCalls: number } {
  const o = {
    fetchCalls: 0,
    async verifyAccessToken(t: string) { if (t === "good") return "did:privy:abc"; throw new AuthError("bad"); },
    async fetchSolanaWallet(_did: string) { o.fetchCalls++; return "So1anaAddr111"; },
  };
  return o;
}

describe("requireUser", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  function app(opts: { devAuth?: boolean; privyAuth?: PrivyAuth | null } = {}) {
    const a = Fastify();
    const requireUser = makeRequireUser({ users: ctx.users, devAuth: opts.devAuth ?? true, privyAuth: opts.privyAuth ?? null });
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

  it("valid Privy Bearer → privy:<did> user, captures the wallet once", async () => {
    const privy = fakePrivy();
    const a = app({ privyAuth: privy });
    const r1 = await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer good" } });
    expect(r1.statusCode).toBe(200);
    const user = await ctx.users.get(r1.json().userId);
    expect(user!.externalId).toBe("privy:did:privy:abc");
    expect(user!.walletPublicKey).toBe("So1anaAddr111");
    // second request does NOT re-fetch the wallet (already stored)
    await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer good" } });
    expect(privy.fetchCalls).toBe(1);
    await a.close();
  });

  it("invalid Privy Bearer → 401", async () => {
    const a = app({ privyAuth: fakePrivy() });
    const r = await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer nope" } });
    expect(r.statusCode).toBe(401); await a.close();
  });
});
