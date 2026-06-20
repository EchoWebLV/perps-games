import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("users service", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("creates a user once and is idempotent by externalId", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    const b = await ctx.users.upsertByExternalId("dev:alice");
    expect(a.id).toBe(b.id);
    expect(a.externalId).toBe("dev:alice");
  });

  it("creates distinct users for distinct externalIds", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    const b = await ctx.users.upsertByExternalId("dev:bob");
    expect(a.id).not.toBe(b.id);
  });

  it("get() returns the user by id", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    const got = await ctx.users.get(a.id);
    expect(got?.id).toBe(a.id);
  });
});
