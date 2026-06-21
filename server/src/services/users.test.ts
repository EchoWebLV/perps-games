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
});
