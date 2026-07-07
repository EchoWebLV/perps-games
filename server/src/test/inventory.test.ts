import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("inventory (unlock-only)", () => {
  let ctx: TestCtx;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
  });
  afterEach(async () => { await ctx.close(); });

  it("grants a car once", async () => {
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: true, count: 1 });
    expect(await ctx.inventory.owns(userId, "orion")).toBe(true);
  });

  it("granting an owned car stacks a duplicate", async () => {
    await ctx.inventory.grant(userId, "orion");
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: false, count: 2 });
    expect((await ctx.inventory.list(userId)).length).toBe(1);
  });

  it("lists all owned cars", async () => {
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "clowncar");
    const cars = (await ctx.inventory.list(userId)).map((r) => r.carId).sort();
    expect(cars).toEqual(["clowncar", "orion"]);
  });
});
