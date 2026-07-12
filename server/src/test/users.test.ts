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

  it("stores a normalized driver name and allows later renames", async () => {
    const user = await ctx.users.upsertByExternalId("dev:named");

    expect(await ctx.users.driverName(user.id)).toBeNull();
    expect(await ctx.users.setDriverName(user.id, "  Liq_Dodger ")).toBe("liq_dodger");
    expect(await ctx.users.setDriverName(user.id, "new_driver")).toBe("new_driver");
    expect(await ctx.users.driverName(user.id)).toBe("new_driver");
  });

  it.each(["", "ab", "spaces fail", "way_too_long_driver_name"])(
    "rejects invalid driver name %j",
    async (name) => {
      const user = await ctx.users.upsertByExternalId("dev:invalid");
      await expect(ctx.users.setDriverName(user.id, name)).rejects.toThrow("invalid_driver_name");
    },
  );

  it("keeps driver names isolated per account", async () => {
    const a = await ctx.users.upsertByExternalId("dev:name-a");
    const b = await ctx.users.upsertByExternalId("dev:name-b");

    await ctx.users.setDriverName(a.id, "road_king");
    await ctx.users.setDriverName(b.id, "liq_dodger");

    expect(await ctx.users.driverName(a.id)).toBe("road_king");
    expect(await ctx.users.driverName(b.id)).toBe("liq_dodger");
  });

  it("claimWelcome grants exactly once per account, then never again", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    expect(await ctx.users.claimWelcome(a.id)).toEqual({ granted: true });
    expect(await ctx.users.claimWelcome(a.id)).toEqual({ granted: false });
    expect(await ctx.users.claimWelcome(a.id)).toEqual({ granted: false });
  });

  it("reports welcome pending without consuming the claim", async () => {
    const user = await ctx.users.upsertByExternalId("dev:pending");

    expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: true });
    expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: true });
    expect(await ctx.users.claimWelcome(user.id)).toEqual({ granted: true });
    expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: false });
  });

  it("claimWelcome grants each distinct user once, independently", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    const b = await ctx.users.upsertByExternalId("dev:bob");
    expect(await ctx.users.claimWelcome(a.id)).toEqual({ granted: true });
    expect(await ctx.users.claimWelcome(b.id)).toEqual({ granted: true });
    // each already claimed → both now false
    expect(await ctx.users.claimWelcome(a.id)).toEqual({ granted: false });
    expect(await ctx.users.claimWelcome(b.id)).toEqual({ granted: false });
  });

  it("redeemAccess grants a code exactly once per account, then never again", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: true });
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: false });
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: false });
  });

  it("redeemAccess normalizes (trim + lowercase) so casing/whitespace variants redeem once", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    expect(await ctx.users.redeemAccess(a.id, "  GoLd ")).toEqual({ granted: true });
    // same code, different casing/whitespace → already redeemed
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: false });
    expect(await ctx.users.accessCodes(a.id)).toEqual(["gold"]);
  });

  it("redeemAccess treats distinct codes on one account independently", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    expect(await ctx.users.redeemAccess(a.id, "alpha")).toEqual({ granted: true });
    expect(await ctx.users.redeemAccess(a.id, "beta")).toEqual({ granted: true });
    expect(await ctx.users.redeemAccess(a.id, "alpha")).toEqual({ granted: false });
    expect((await ctx.users.accessCodes(a.id)).sort()).toEqual(["alpha", "beta"]);
  });

  it("redeemAccess is independent across distinct accounts", async () => {
    const a = await ctx.users.upsertByExternalId("dev:alice");
    const b = await ctx.users.upsertByExternalId("dev:bob");
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: true });
    expect(await ctx.users.redeemAccess(b.id, "gold")).toEqual({ granted: true });
    // a already redeemed gold → false; b's redemption unaffected
    expect(await ctx.users.redeemAccess(a.id, "gold")).toEqual({ granted: false });
    expect(await ctx.users.accessCodes(b.id)).toEqual(["gold"]);
  });

  it("accessCodes is [] for a fresh account", async () => {
    const a = await ctx.users.upsertByExternalId("dev:fresh");
    expect(await ctx.users.accessCodes(a.id)).toEqual([]);
  });
});
