import { eq } from "drizzle-orm";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { users } from "../db/schema.js";
import { makeTestDb, type TestCtx } from "../test/harness.js";

describe("users.setWalletPublicKey", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("does not expose a wallet sync bypass helper", async () => {
    const removedHelper = ["sync", "Verified", "Wallet", "Public", "Key"].join("");
    expect(removedHelper in ctx.users).toBe(false);
  });

  it("stores and returns the wallet address on a user", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:abc");
    expect(u.walletPublicKey ?? null).toBeNull();
    const updated = await ctx.users.setWalletPublicKey(u.id, "So1anaAddr111");
    expect(updated.walletPublicKey).toBe("So1anaAddr111");
    const reread = await ctx.users.get(u.id);
    expect(reread!.walletPublicKey).toBe("So1anaAddr111");
  });

  it("is set-once: a second bind to a DIFFERENT address is ignored", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:xyz");
    await ctx.users.setWalletPublicKey(u.id, "WalletAAA");
    const after = await ctx.users.setWalletPublicKey(u.id, "WalletBBB");
    expect(after.walletPublicKey).toBe("WalletAAA");
    expect((await ctx.users.get(u.id))!.walletPublicKey).toBe("WalletAAA");
  });

  it("is idempotent: re-binding the SAME address is a no-op", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:qqq");
    await ctx.users.setWalletPublicKey(u.id, "WalletSame");
    const again = await ctx.users.setWalletPublicKey(u.id, "WalletSame");
    expect(again.walletPublicKey).toBe("WalletSame");
  });

  it("alerts exactly once on a DIFFERENT-address rebind, never on first-bind or same-address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await ctx.users.upsertByExternalId("privy:did:privy:alert");
      await ctx.users.setWalletPublicKey(u.id, "WalletFirst"); // first bind → no alert
      expect(warn).not.toHaveBeenCalled();
      await ctx.users.setWalletPublicKey(u.id, "WalletFirst"); // same address → no alert (no fatigue)
      expect(warn).not.toHaveBeenCalled();
      await ctx.users.setWalletPublicKey(u.id, "WalletEvil"); // different address → alert once
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/\[wallet_rebind_attempt\]/);
    } finally {
      warn.mockRestore();
    }
  });

  it("enforces wallet uniqueness at the database level for non-null bindings", async () => {
    const a = await ctx.users.upsertByExternalId("privy:did:privy:db-unique-a");
    const b = await ctx.users.upsertByExternalId("privy:did:privy:db-unique-b");

    await ctx.users.setWalletPublicKey(a.id, "WalletShared");

    await expect(
      ctx.db
        .update(users)
        .set({ walletPublicKey: "WalletShared" })
        .where(eq(users.id, b.id)),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
