import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeInventory, type Inventory } from "./inventory.js";
import { makeUpgrades, type Upgrades } from "./upgrades.js";
import { makeEntitlements, type Entitlements } from "./entitlements.js";

describe("makeEntitlements (perk-envelope oracle)", () => {
  let ctx: TestCtx;
  let userId: string;
  let inventory: Inventory;
  let upgrades: Upgrades;
  let svc: Entitlements;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:tester")).id;
    inventory = makeInventory(ctx.db);
    upgrades = makeUpgrades(ctx.db, ctx.ledger);
    svc = makeEntitlements({ inventory, upgrades });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("rejects a car the user does not own", async () => {
    await expect(svc.entitlementsFor(userId, "Orion")).rejects.toThrow(/car_not_owned/);
  });

  it("returns the envelope for an owned car at the user's levels", async () => {
    await inventory.grant(userId, "Orion");
    await ctx.ledger.credit(userId, "coin", 100000, "dev_grant", `seed-coin:${userId}`);
    await ctx.ledger.credit(userId, "scrap", 100000, "dev_grant", `seed:${userId}`);
    for (let i = 0; i < 10; i++) await upgrades.buy(userId, "turbo");
    expect((await svc.entitlementsFor(userId, "Orion")).maxLev).toBe(3000); // nitro at maxed turbo: 1500*2
  });
});
