import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { withdrawals } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { makeWithdrawProcessor } from "./withdraw-worker.js";

async function seedWithdrawal(ctx: TestCtx, status: string) {
  const u = await ctx.users.upsertByExternalId("privy:did:privy:w");
  const id = crypto.randomUUID();
  await ctx.db.insert(withdrawals).values({
    id, userId: u.id, amountCents: 300, destWallet: "WALLET_W", status,
    privyIdempotencyKey: `withdraw:${id}`,
  });
  return id;
}

describe("withdraw processor (approval → signing → sent)", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("approve() drives awaiting_approval → sent via the signer, recording txSig", async () => {
    const id = await seedWithdrawal(ctx, "awaiting_approval");
    const signer = { async signAndSend() { return { txSig: "SIG123", privyTxId: "ptx" }; } };
    const proc = makeWithdrawProcessor(ctx.db, signer);
    const r = await proc.approveAndSend(id);
    expect(r.status).toBe("sent");
    const row = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0];
    expect(row.status).toBe("sent");
    expect(row.txSig).toBe("SIG123");
    expect(row.privyTxId).toBe("ptx");
  });

  it("refuses to approve a withdrawal that is not awaiting_approval", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { return { txSig: "x", privyTxId: null }; } });
    expect((await proc.approveAndSend(id)).status).toBe("not_approvable");
  });

  it("if the signer throws, the row stays in signing (no money left; safe to retry)", async () => {
    const id = await seedWithdrawal(ctx, "awaiting_approval");
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { throw new Error("privy down"); } });
    await expect(proc.approveAndSend(id)).rejects.toThrow(/privy down/);
    const row = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0];
    expect(row.status).toBe("signing");
  });
});
