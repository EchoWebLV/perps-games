import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { drawsFromSeed } from "../services/crate-roll.js";
import { makeTestDb, bindDevWallet, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "crate-alice", "content-type": "application/json" };
const ZERO = "0".repeat(64);

/** Take a commitment from the server the way the client does, before choosing a crate. */
async function commit(ctx: TestCtx): Promise<{ commitId: string; commitment: string }> {
  const res = await ctx.server.inject({ method: "POST", url: "/v1/crates/commit", headers: H, payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("POST /v1/crates/commit", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("publishes a commitment and nothing that reveals the roll", async () => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "crate-alice");
    const body = await commit(ctx);
    expect(body.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(body.commitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body).sort()).toEqual(["commitId", "commitment"]); // no seed, no nonce
  });

  it("refuses a session with no bound wallet", async () => {
    ctx = await makeTestDb();
    const res = await ctx.server.inject({ method: "POST", url: "/v1/crates/commit", headers: H, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /v1/crates/open", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("debits coins, rolls from the consumed commit, reveals it, and advances pity", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const c = await commit(ctx);
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", commitId: c.commitId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.carId).toBeTruthy();
    expect(body.coins).toBe(750);
    expect(body.scrap).toBeGreaterThan(0);
    expect(body.pity.wooden).toBeGreaterThanOrEqual(0);

    // the reveal must verify against the commitment the server published BEFORE the open
    const check = createHash("sha256")
      .update(Buffer.from(body.reveal.seedHex, "hex"))
      .update(Buffer.from(body.reveal.nonceHex, "hex"))
      .digest("hex");
    expect(check).toBe(c.commitment);
    expect(body.reveal.commitment).toBe(c.commitment);
    // and the draws the outcome came from must be the ones the seed derives
    expect(body.draws).toEqual(drawsFromSeed(Buffer.from(body.reveal.seedHex, "hex"), 4));
  });

  it("refuses to spend the same commit twice", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const c = await commit(ctx);
    const payload = { crateKey: "wooden", payment: "coins", commitId: c.commitId };
    const first = await ctx.server.inject({ method: "POST", url: "/v1/crates/open", headers: H, payload });
    expect(first.statusCode).toBe(200);
    const again = await ctx.server.inject({ method: "POST", url: "/v1/crates/open", headers: H, payload });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("commit_used");
    // the replayed open must NOT have charged a second time
    expect(await ctx.ledger.balance(userId, "coin")).toBe(750);
  });

  it("refuses another account's commit", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    await bindDevWallet(ctx, "crate-bob");
    const bob = (await ctx.users.upsertByExternalId("dev:crate-bob")).id;
    await ctx.ledger.credit(bob, "coin", 1000, "earn", "fund");

    const c = await commit(ctx); // alice's commit
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open",
      headers: { "x-dev-user": "crate-bob", "content-type": "application/json" },
      payload: { crateKey: "wooden", payment: "coins", commitId: c.commitId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("commit_not_found");
  });

  it("refuses an unfunded coin open", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const c = await commit(ctx);
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "gold", payment: "coins", commitId: c.commitId },
    });
    expect(res.statusCode).toBe(402);
  });

  it("will not roll from client-supplied VRF bytes on the EVM rail", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", vrfBytes: ZERO },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("commit_required");
    expect(await ctx.ledger.balance(userId, "coin")).toBe(1000); // nothing charged
  });

  it("still accepts MagicBlock VRF bytes on the parked Solana rail", async () => {
    ctx = await makeTestDb({ signupFaucet: false, chainFamily: "solana" });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", vrfBytes: ZERO },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().carId).toBeTruthy();
    expect(res.json().reveal).toBeUndefined(); // no commit was spent, so nothing to reveal

    const again = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", vrfBytes: ZERO },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("crate_replay");
  });

  it("prefers the commit when a Solana client sends both sources", async () => {
    ctx = await makeTestDb({ signupFaucet: false, chainFamily: "solana" });
    await bindDevWallet(ctx, "crate-alice");
    const userId = (await ctx.users.upsertByExternalId("dev:crate-alice")).id;
    await ctx.ledger.credit(userId, "coin", 1000, "earn", "fund");

    const c = await commit(ctx);
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/crates/open", headers: H,
      payload: { crateKey: "wooden", payment: "coins", commitId: c.commitId, vrfBytes: ZERO },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().draws).toEqual(drawsFromSeed(Buffer.from(res.json().reveal.seedHex, "hex"), 4));
  });
});
