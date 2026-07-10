import { afterEach, describe, expect, it } from "vitest";
import { bindDevWallet, makeTestDb, type TestCtx } from "./harness.js";

const headersFor = (name: string) => ({
  "x-dev-user": name,
  "content-type": "application/json",
});

const body = {
  id: "11111111-1111-4111-8111-111111111111",
  asset: "SOL",
  dir: 1,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150.25,
  exitPrice: 151.5,
  openedAt: "2026-07-10T10:00:00.000Z",
  outcome: "cashout",
  payoutBase: 11_000_000,
};

describe("trade history routes", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("records idempotently", async () => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");

    const first = await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("trade-alice"),
      payload: body,
    });
    const replay = await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("trade-alice"),
      payload: body,
    });
    const list = await ctx.server.inject({
      method: "GET",
      url: "/v1/trades?limit=25",
      headers: headersFor("trade-alice"),
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      id: body.id,
      walletPublicKey: "AliceWallet",
      pnlBase: 1_000_000,
    });
  });

  it("lists only the authenticated account", async () => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "isolated-alice", "IsolatedAliceWallet");
    await bindDevWallet(ctx, "isolated-bob", "IsolatedBobWallet");
    const bob = await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("isolated-bob"),
      payload: {
        ...body,
        id: "22222222-2222-4222-8222-222222222222",
      },
    });

    const aliceList = await ctx.server.inject({
      method: "GET",
      url: "/v1/trades",
      headers: headersFor("isolated-alice"),
    });

    expect(bob.statusCode).toBe(200);
    expect(aliceList.statusCode).toBe(200);
    expect(aliceList.json()).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    { method: "POST" as const, url: "/v1/trades", payload: body },
    { method: "GET" as const, url: "/v1/trades", payload: undefined },
  ])("requires a wallet-bound account for $method $url", async ({ method, url, payload }) => {
    ctx = await makeTestDb();

    const response = await ctx.server.inject({
      method,
      url,
      headers: headersFor("trade-unbound"),
      payload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "wallet_required" });
  });

  it("returns a conflict when another account already owns the trade id", async () => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");
    await bindDevWallet(ctx, "trade-bob", "BobWallet");
    await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("trade-alice"),
      payload: body,
    });

    const conflict = await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("trade-bob"),
      payload: body,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "trade_id_conflict" });
  });

  it.each([
    ["negative payout", { payoutBase: -1 }],
    ["unsafe stake", { stakeBase: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe payout", { payoutBase: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s numeric input", async (_name, override) => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");

    const response = await ctx.server.inject({
      method: "POST",
      url: "/v1/trades",
      headers: headersFor("trade-alice"),
      payload: { ...body, ...override },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "bad_request" });
  });

  it.each([
    ["an empty", "/v1/trades?cursor=", "bad_request"],
    ["a malformed", "/v1/trades?cursor=not-base64", "bad_cursor"],
  ])("maps %s cursor to 400", async (_name, url, error) => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");

    const response = await ctx.server.inject({
      method: "GET",
      url,
      headers: headersFor("trade-alice"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error });
  });
});
