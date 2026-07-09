import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";
import { makeSessionAuth } from "../auth/session.js";

// same secret the default harness sessionAuth uses, so tokens minted here verify on the server.
const SECRET = "test-session-secret-32-characters-long";

/** an ANONYMOUS session (valid token, but no wallet bound). */
async function anonToken(ctx: TestCtx): Promise<string> {
  const sa = makeSessionAuth({ users: ctx.users, secret: SECRET });
  return (await sa.issueAnonymous()).token;
}

/** a WALLET-BOUND session: an anonymous user that has since bound a wallet. */
async function walletBoundToken(ctx: TestCtx, wallet: string): Promise<string> {
  const sa = makeSessionAuth({ users: ctx.users, secret: SECRET });
  const issued = await sa.issueAnonymous();
  await ctx.users.setWalletPublicKey(issued.userId, wallet);
  return issued.token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

// every economy-MUTATING endpoint now requires a wallet-bound session.
const MUTATING: Array<{ url: string; payload: Record<string, unknown> }> = [
  { url: "/v1/coins/earn", payload: { amount: 10, ref: "e1" } },
  { url: "/v1/coins/spend", payload: { amount: 10, ref: "s1" } },
  { url: "/v1/scrap/earn", payload: { amount: 10, ref: "se1" } },
  { url: "/v1/scrap/spend", payload: { amount: 10, ref: "ss1" } },
  { url: "/v1/inventory/grant", payload: { carId: "orion" } },
  { url: "/v1/inventory/melt", payload: { carId: "orion" } },
  { url: "/v1/migrate", payload: { coins: 10, scrap: 0, cars: {} } },
];

describe("economy-mutating endpoints require a wallet-bound session", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb({ signupFaucet: false, devAuth: false }); });
  afterEach(async () => { await ctx.close(); });

  it("rejects an ANONYMOUS session (403 wallet_required) on every mutating endpoint", async () => {
    const token = await anonToken(ctx);
    for (const { url, payload } of MUTATING) {
      const res = await ctx.server.inject({ method: "POST", url, headers: bearer(token), payload });
      expect(res.statusCode, `${url} should reject anon`).toBe(403);
      expect(res.json()).toEqual({ error: "wallet_required" });
    }
  });

  it("rejects a request with NO auth (401) on every mutating endpoint", async () => {
    for (const { url, payload } of MUTATING) {
      const res = await ctx.server.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });
      expect(res.statusCode, `${url} should 401 without auth`).toBe(401);
    }
  });

  it("accepts a WALLET-BOUND session: earn/grant/migrate succeed, spend passes auth (402, not 403)", async () => {
    const earn = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: bearer(await walletBoundToken(ctx, "WalletEarn")), payload: { amount: 25, ref: "e1" } });
    expect(earn.statusCode).toBe(200);
    expect(earn.json().coins).toBe(25);

    const grant = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: bearer(await walletBoundToken(ctx, "WalletGrant")), payload: { carId: "orion" } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toEqual({ carId: "orion", isNew: true, count: 1 });

    const migrate = await ctx.server.inject({ method: "POST", url: "/v1/migrate", headers: bearer(await walletBoundToken(ctx, "WalletMigrate")), payload: { coins: 100, scrap: 5, cars: {} } });
    expect(migrate.statusCode).toBe(200);
    expect(migrate.json()).toEqual({ seeded: true });

    // spend on an empty wallet-bound account => 402 (insufficient), NOT 403 — proves it cleared the wallet gate.
    const spend = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: bearer(await walletBoundToken(ctx, "WalletSpend")), payload: { amount: 10, ref: "ss1" } });
    expect(spend.statusCode).toBe(402);
  });
});
