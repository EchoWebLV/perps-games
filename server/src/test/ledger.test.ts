import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("ledger (append-only)", () => {
  let ctx: TestCtx;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
  });
  afterEach(async () => { await ctx.close(); });

  it("starts at zero", async () => {
    expect(await ctx.ledger.balance(userId)).toBe(0);
  });

  it("credit increases balance and is additive", async () => {
    await ctx.ledger.credit(userId, 100, "dev_grant");
    await ctx.ledger.credit(userId, 50, "dev_grant");
    expect(await ctx.ledger.balance(userId)).toBe(150);
  });

  it("rejects non-positive / non-integer credits", async () => {
    await expect(ctx.ledger.credit(userId, 0, "x")).rejects.toThrow();
    await expect(ctx.ledger.credit(userId, -5, "x")).rejects.toThrow();
    await expect(ctx.ledger.credit(userId, 1.5, "x")).rejects.toThrow();
  });

  it("balances are isolated per user", async () => {
    const bob = (await ctx.users.upsertByExternalId("dev:bob")).id;
    await ctx.ledger.credit(userId, 100, "dev_grant");
    expect(await ctx.ledger.balance(bob)).toBe(0);
  });

  it("idempotent on (reason, ref): the same ref posts at most once", async () => {
    await ctx.ledger.credit(userId, 100, "deposit", "tx-abc");
    await ctx.ledger.credit(userId, 100, "deposit", "tx-abc"); // retry
    expect(await ctx.ledger.balance(userId)).toBe(100);
  });

  it("debit reduces balance", async () => {
    await ctx.ledger.credit(userId, 100, "dev_grant");
    await ctx.ledger.debit(userId, 30, "round_stake");
    expect(await ctx.ledger.balance(userId)).toBe(70);
  });

  it("debit refuses to overdraw", async () => {
    await ctx.ledger.credit(userId, 20, "dev_grant");
    await expect(ctx.ledger.debit(userId, 50, "round_stake")).rejects.toThrow(/insufficient/);
    expect(await ctx.ledger.balance(userId)).toBe(20); // unchanged
  });

  it("canAfford reflects balance", async () => {
    await ctx.ledger.credit(userId, 40, "dev_grant");
    expect(await ctx.ledger.canAfford(userId, 40)).toBe(true);
    expect(await ctx.ledger.canAfford(userId, 41)).toBe(false);
  });
});
