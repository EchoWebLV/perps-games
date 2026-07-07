import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("counted inventory", () => {
  let ctx: TestCtx;
  let userId: string;
  afterEach(async () => { await ctx?.close(); });

  it("stacks duplicate grants and reports the count", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;

    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: true, count: 1 });
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: false, count: 2 });
    expect(await ctx.inventory.count(userId, "orion")).toBe(2);
    expect(await ctx.inventory.owns(userId, "orion")).toBe(true);
  });

  it("melt sheds a spare but never the last copy", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:bob")).id;
    await ctx.inventory.grant(userId, "skull");
    await ctx.inventory.grant(userId, "skull"); // count 2
    expect(await ctx.inventory.melt(userId, "skull")).toEqual({ melted: true, count: 1 });
    expect(await ctx.inventory.melt(userId, "skull")).toEqual({ melted: false, count: 1 });
  });

  it("lists owned cars with counts", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:cara")).id;
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "clowncar");
    await ctx.inventory.grant(userId, "clowncar");
    const list = (await ctx.inventory.list(userId)).map((r) => ({ carId: r.carId, count: r.count })).sort((a, b) => a.carId.localeCompare(b.carId));
    expect(list).toEqual([{ carId: "clowncar", count: 2 }, { carId: "orion", count: 1 }]);
  });
});
