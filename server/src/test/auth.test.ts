import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { makeTestDb, type TestCtx } from "./harness.js";
import { makeRequireUser } from "../http/auth.js";
import type { PrivyAuth } from "../auth/privy.js";
import { AuthError } from "../auth/privy.js";

function fakePrivy(wallets: string[] = ["So1anaAddr111"]): PrivyAuth & { fetchCalls: number } {
  const o = {
    fetchCalls: 0,
    async verifyAccessToken(t: string) { if (t === "good") return "did:privy:abc"; throw new AuthError("bad"); },
    async fetchSolanaWallet(_did: string, preferred?: string | null) {
      o.fetchCalls++;
      if (preferred && wallets.includes(preferred)) return preferred;
      return wallets[Math.min(o.fetchCalls - 1, wallets.length - 1)];
    },
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

  it("valid Privy Bearer → privy:<did> user, captures the wallet", async () => {
    const privy = fakePrivy();
    const a = app({ privyAuth: privy });
    const r1 = await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer good" } });
    expect(r1.statusCode).toBe(200);
    const user = await ctx.users.get(r1.json().userId);
    expect(user!.externalId).toBe("privy:did:privy:abc");
    expect(user!.walletPublicKey).toBe("So1anaAddr111");
    expect(privy.fetchCalls).toBe(1);
    await a.close();
  });

  it("syncs a changed verified Privy embedded wallet instead of using a stale cached wallet", async () => {
    const privy = fakePrivy(["WalletOld", "WalletCurrent"]);
    const a = app({ privyAuth: privy });
    const r1 = await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer good" } });
    expect((await ctx.users.get(r1.json().userId))!.walletPublicKey).toBe("WalletOld");

    await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer good" } });

    expect((await ctx.users.get(r1.json().userId))!.walletPublicKey).toBe("WalletCurrent");
    expect(privy.fetchCalls).toBe(2);
    await a.close();
  });

  it("prefers the client-selected Privy wallet when it is verified on the Privy user", async () => {
    const oldWallet = "GfVcyD4kkTrj4bKc3wxW7hCgT7uxK1z6tWb5tWnVy8aF";
    const currentWallet = "ANcAfmuuko7VzC8vUZnn7bbg12BxyC9JNLCCJKQmbKf4";
    const privy = fakePrivy([oldWallet, currentWallet]);
    const a = app({ privyAuth: privy });

    const r = await a.inject({
      method: "GET",
      url: "/who",
      headers: { authorization: "Bearer good", "x-privy-wallet": currentWallet },
    });

    expect(r.statusCode).toBe(200);
    expect((await ctx.users.get(r.json().userId))!.walletPublicKey).toBe(currentWallet);
    await a.close();
  });

  it("invalid Privy Bearer → 401", async () => {
    const a = app({ privyAuth: fakePrivy() });
    const r = await a.inject({ method: "GET", url: "/who", headers: { authorization: "Bearer nope" } });
    expect(r.statusCode).toBe(401); await a.close();
  });

  // --- security-property tests (1.3 adversarial review) ---

  it("Bearer wins over dev: a request with BOTH resolves to the Privy user", async () => {
    const a = app({ devAuth: true, privyAuth: fakePrivy() });
    const r = await a.inject({
      method: "GET",
      url: "/who",
      headers: { authorization: "Bearer good", "x-dev-user": "alice" },
    });
    expect(r.statusCode).toBe(200);
    const user = await ctx.users.get(r.json().userId);
    expect(user!.externalId).toBe("privy:did:privy:abc"); // NOT dev:alice
    await a.close();
  });

  it("namespace isolation: x-dev-user 'did:privy:abc' is REJECTED 401 (colon fails validation)", async () => {
    // devAuth on, no privy backend — a crafted dev name that mimics a Privy DID
    // must never mint a user that could collide with the real privy:did:privy:abc.
    const a = app({ devAuth: true, privyAuth: null });
    const r = await a.inject({ method: "GET", url: "/who", headers: { "x-dev-user": "did:privy:abc" } });
    expect(r.statusCode).toBe(401);
    await a.close();
  });

  it("Bearer with no backend → 401 (Fix A): token is rejected, NOT downgraded to dev", async () => {
    // A presented Bearer must never fall through to the weaker dev path.
    const a = app({ devAuth: true, privyAuth: null });
    const r = await a.inject({
      method: "GET",
      url: "/who",
      headers: { authorization: "Bearer good", "x-dev-user": "alice" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("no_auth_backend");
    await a.close();
  });

  it("dev name validation (Fix B): too-long or colon-containing → 401; web-<uuid> → 200", async () => {
    const a = app({ devAuth: true, privyAuth: null });

    // 100-char name → too long → 401
    const tooLong = await a.inject({
      method: "GET",
      url: "/who",
      headers: { "x-dev-user": "a".repeat(100) },
    });
    expect(tooLong.statusCode).toBe(401);

    // colon-containing → 401
    const withColon = await a.inject({
      method: "GET",
      url: "/who",
      headers: { "x-dev-user": "foo:bar" },
    });
    expect(withColon.statusCode).toBe(401);

    // the real client value web-<uuid> → 200
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
