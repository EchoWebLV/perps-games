import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { withdrawals } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { makeWithdrawProcessor, makeWithdrawConfirmer } from "./withdraw-worker.js";

async function seedWithdrawal(ctx: TestCtx, status: string, txSig: string | null | undefined = undefined) {
  const u = await ctx.users.upsertByExternalId("privy:did:privy:w");
  const id = crypto.randomUUID();
  // For "sent" rows: auto-generate a sig unless caller explicitly passes null (to test the guard) or a specific string.
  const resolvedTxSig = status === "sent" ? (txSig === undefined ? `SIG-${id}` : txSig) : (txSig ?? null);
  await ctx.db.insert(withdrawals).values({
    id, userId: u.id, amountCents: 300, destWallet: "WALLET_W", status,
    txSig: resolvedTxSig,
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
    const signer = { async signAndSend() { return { txSig: "SIG123", providerTxId: "ptx" }; } };
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
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { return { txSig: "x", providerTxId: null }; } });
    expect((await proc.approveAndSend(id)).status).toBe("not_approvable");
  });

  it("if the signer throws, the row stays in signing (no money left; safe to retry)", async () => {
    const id = await seedWithdrawal(ctx, "awaiting_approval");
    const proc = makeWithdrawProcessor(ctx.db, { async signAndSend() { throw new Error("provider down"); } });
    await expect(proc.approveAndSend(id)).rejects.toThrow(/provider down/);
    const row = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0];
    expect(row.status).toBe("signing");
  });
});

describe("withdraw confirmer (never auto-reverse on inference)", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("sent → confirmed on a positive finalized observation", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "finalized");
    const r = await proc.confirm(id);
    expect(r).toBe("confirmed");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("confirmed");
  });

  it("sent → needs_review on an UNKNOWN status (cash stays debited; never auto-reversed)", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "unknown");
    expect(await proc.confirm(id)).toBe("needs_review");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("needs_review");
  });

  it("sent → reversed + cash re-credited ONLY on a landed-but-FAILED tx (no tokens moved)", async () => {
    const id = await seedWithdrawal(ctx, "sent");
    const u = (await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].userId;
    await ctx.ledger.post(u, "cash", -300, "withdraw_reserve", id); // mirror the reserve debit
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => "failed");
    expect(await proc.confirm(id)).toBe("reversed");
    expect((await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0].status).toBe("reversed");
    expect(await ctx.ledger.balance(u, "cash")).toBe(0); // -300 reserve + +300 reverse
  });

  it("skips a malformed sent row with no txSig (guard, never calls the chain reader)", async () => {
    let called = false;
    const id = await seedWithdrawal(ctx, "sent", null); // force txSig null on a sent row
    const proc = makeWithdrawConfirmer(ctx.db, ctx.ledger, async () => { called = true; return "finalized"; });
    expect(await proc.confirm(id)).toBe("skip");
    expect(called).toBe(false); // the guard short-circuits before readStatus
  });
});
