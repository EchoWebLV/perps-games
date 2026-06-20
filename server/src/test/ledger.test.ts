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
});
