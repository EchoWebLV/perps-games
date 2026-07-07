import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("scrap ledger asset", () => {
  let ctx: TestCtx;
  let userId: string;
  afterEach(async () => { await ctx?.close(); });

  it("credits, debits, and reads a scrap balance independent of coins", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;

    await ctx.ledger.credit(userId, "scrap", 25, "scrap_earn", "r1");
    await ctx.ledger.credit(userId, "coin", 100, "earn", "c1");
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(25);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(100);

    await ctx.ledger.debit(userId, "scrap", 10, "scrap_spend", "r2");
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(15);
  });

  it("is idempotent on (asset, reason, ref)", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:bob")).id;
    await ctx.ledger.credit(userId, "scrap", 5, "scrap_earn", "dup");
    await ctx.ledger.credit(userId, "scrap", 5, "scrap_earn", "dup"); // replay swallowed
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(5);
  });
});
