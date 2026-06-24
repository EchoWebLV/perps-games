import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { seedHouseFromAccount } from "./house.js";

describe("seedHouseFromAccount (atomic bankroll bootstrap)", () => {
  let ctx: TestCtx;
  let playerId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    playerId = (await ctx.users.upsertByExternalId("dev:seed-player")).id;
  });
  afterEach(async () => { await ctx.close(); });

  it("re-labels player cash as house bankroll, conserving the total", async () => {
    await ctx.ledger.credit(playerId, "cash", 1000, "deposit", "fund-1");
    const out = await seedHouseFromAccount(ctx.db, ctx.ledger, playerId, ctx.houseUserId, 600, "ref-a");
    expect(out).toBe("moved");
    expect(await ctx.ledger.balance(playerId, "cash")).toBe(400);          // debited
    expect(await ctx.ledger.balance(ctx.houseUserId, "cash")).toBe(600);   // credited
    // total cash unchanged — nothing minted or burned
    expect((await ctx.ledger.balance(playerId, "cash")) + (await ctx.ledger.balance(ctx.houseUserId, "cash"))).toBe(1000);
  });

  it("never double-moves: a replay with the same ref is an idempotent no-op", async () => {
    await ctx.ledger.credit(playerId, "cash", 1000, "deposit", "fund-2");
    expect(await seedHouseFromAccount(ctx.db, ctx.ledger, playerId, ctx.houseUserId, 400, "ref-b")).toBe("moved");
    expect(await seedHouseFromAccount(ctx.db, ctx.ledger, playerId, ctx.houseUserId, 400, "ref-b")).toBe("noop");
    // balances identical to a single application — the replay moved nothing and lost nothing
    expect(await ctx.ledger.balance(playerId, "cash")).toBe(600);
    expect(await ctx.ledger.balance(ctx.houseUserId, "cash")).toBe(400);
  });

  it("throws on insufficient cash and moves NOTHING (the credit leg never posts)", async () => {
    await ctx.ledger.credit(playerId, "cash", 100, "deposit", "fund-3");
    await expect(seedHouseFromAccount(ctx.db, ctx.ledger, playerId, ctx.houseUserId, 600, "ref-c")).rejects.toThrow(/insufficient balance/);
    expect(await ctx.ledger.balance(playerId, "cash")).toBe(100);        // debit rolled back
    expect(await ctx.ledger.balance(ctx.houseUserId, "cash")).toBe(0);   // credit never happened
  });
});
