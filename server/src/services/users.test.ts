import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";

describe("users.setWalletPublicKey", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

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
});
