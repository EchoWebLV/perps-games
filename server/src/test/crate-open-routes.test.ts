import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, bindDevWallet, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "crate-alice", "content-type": "application/json" };
const ZERO = "0".repeat(64);

describe("POST /v1/crates/open", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("debits coins, grants from VRF bytes, and advances pity", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", vrfBytes: ZERO },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.carId).toBeTruthy();
    expect(body.coins).toBe(750);
    expect(body.scrap).toBeGreaterThan(0);
    expect(body.pity.wooden).toBeGreaterThanOrEqual(0);

    const again = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", vrfBytes: ZERO },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("crate_replay");
  });

  it("refuses an unfunded coin open", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "gold", payment: "coins", vrfBytes: ZERO },
    });
    expect(res.statusCode).toBe(402);
  });
});
