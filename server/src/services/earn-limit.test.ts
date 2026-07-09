import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeEarnLimit, type EarnLimit } from "./earn-limit.js";

describe("makeEarnLimit (rolling per-reason earn ceiling)", () => {
  let ctx: TestCtx;
  let userId: string;
  let limit: EarnLimit;
  beforeEach(async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:tester")).id;
    limit = makeEarnLimit(ctx.db, { ceiling: 100, windowMs: 60_000 });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("allows an earn under the window ceiling", async () => {
    expect(await limit.check(userId, "earn", 60)).toBe(true);
  });

  it("rejects an earn that would exceed the ceiling within the window", async () => {
    await ctx.ledger.credit(userId, "coin", 80, "earn", `${userId}:a`);
    expect(await limit.check(userId, "earn", 30)).toBe(false);
  });

  it("windows are per-reason (scrap_earn independent of earn)", async () => {
    await ctx.ledger.credit(userId, "coin", 100, "earn", `${userId}:b`);
    expect(await limit.check(userId, "scrap_earn", 50)).toBe(true);
  });
});
