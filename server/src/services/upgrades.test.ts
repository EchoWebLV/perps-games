import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeUpgrades, type Upgrades } from "./upgrades.js";
import { MAX_UPGRADE_LEVEL } from "@perps/engine";

describe("makeUpgrades (authoritative upgrade levels)", () => {
  let ctx: TestCtx;
  let userId: string;
  let upgrades: Upgrades;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:tester")).id;
    upgrades = makeUpgrades(ctx.db, ctx.ledger);
    await ctx.ledger.credit(userId, "coin", 1000, "dev_grant", `seed:${userId}`);
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("defaults to all-zero levels for a fresh user", async () => {
    expect(await upgrades.get(userId)).toEqual({ turbo: 0, tank: 0, suspension: 0 });
  });

  it("buy debits the escalating cost and increments the level", async () => {
    expect(await upgrades.buy(userId, "turbo")).toEqual({ track: "turbo", level: 1, coins: 980 });
    expect((await upgrades.get(userId)).turbo).toBe(1);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(980);
  });

  it("rejects when coins can't cover the cost (no level change)", async () => {
    await ctx.ledger.debit(userId, "coin", 1000, "spend", `drain:${userId}`);
    await expect(upgrades.buy(userId, "turbo")).rejects.toThrow(/insufficient balance/);
    expect((await upgrades.get(userId)).turbo).toBe(0);
  });

  it("rejects buying past MAX_UPGRADE_LEVEL", async () => {
    await ctx.ledger.credit(userId, "coin", 100000, "dev_grant", `topup:${userId}`);
    for (let i = 0; i < MAX_UPGRADE_LEVEL; i++) await upgrades.buy(userId, "turbo");
    expect((await upgrades.get(userId)).turbo).toBe(MAX_UPGRADE_LEVEL);
    await expect(upgrades.buy(userId, "turbo")).rejects.toThrow(/max_level/);
  });

  it("seed sets levels directly (migration path)", async () => {
    const levels = { turbo: 3, tank: 2, suspension: 1 };
    expect(await upgrades.seed(userId, levels)).toEqual(levels);
    expect(await upgrades.get(userId)).toEqual(levels);
  });
});
