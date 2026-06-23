import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";

describe("ledger asset seam", () => {
  let ctx: TestCtx;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
  });
  afterEach(async () => { await ctx.close(); });

  it("keeps coin and cash balances separate", async () => {
    await ctx.ledger.credit(userId, "coin", 100, "dev_grant");
    await ctx.ledger.credit(userId, "cash", 500, "deposit", "tx-sig-1");
    expect(await ctx.ledger.balance(userId, "coin")).toBe(100);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("a coin balance is NOT spendable as cash (the faucet cannot be withdrawn)", async () => {
    await ctx.ledger.credit(userId, "coin", 10000, "signup_faucet", userId);
    await expect(
      ctx.ledger.debit(userId, "cash", 100, "withdraw_reserve", "wd-1"),
    ).rejects.toThrow(/insufficient balance/);
  });

  it("idempotency is per (asset, reason, ref): the same ref on different assets both post", async () => {
    expect(await ctx.ledger.credit(userId, "coin", 50, "promo", "ref-x")).toBe(true);
    expect(await ctx.ledger.credit(userId, "cash", 50, "promo", "ref-x")).toBe(true);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(50);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(50);
  });

  it("a replayed withdraw_reserve debit is swallowed and returns false (no double-debit)", async () => {
    await ctx.ledger.credit(userId, "cash", 1000, "deposit", "fund-1");
    const first = await ctx.ledger.debit(userId, "cash", 300, "withdraw_reserve", "wd-42");
    const second = await ctx.ledger.debit(userId, "cash", 300, "withdraw_reserve", "wd-42");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(700);
  });

  it("a duplicate (asset, reason, ref) credit is a no-op and returns false", async () => {
    expect(await ctx.ledger.credit(userId, "cash", 200, "deposit", "dup-sig")).toBe(true);
    expect(await ctx.ledger.credit(userId, "cash", 200, "deposit", "dup-sig")).toBe(false);
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("a cash-moving reason with a null ref throws (idempotency cannot be bypassed)", async () => {
    await expect(ctx.ledger.credit(userId, "cash", 100, "deposit")).rejects.toThrow(/requires a non-null ref/);
    await expect(ctx.ledger.debit(userId, "cash", 100, "withdraw_reserve")).rejects.toThrow(/requires a non-null ref/);
  });
});
