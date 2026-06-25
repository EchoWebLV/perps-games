import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeWithdrawals } from "./withdrawals.js";
import { deposits, depositSources, withdrawals } from "../db/schema.js";
import { eq } from "drizzle-orm";

const cfg = {
  minCents: 100, maxCents: 500, userDailyCapCents: 2000, globalDailyCapCents: 20000,
  holdHours: 24, quorumThresholdCents: 0,
};

async function seedFundedUser(ctx: TestCtx, ext: string, wallet: string, cashCents: number, depositAgeHours = 48) {
  const u = await ctx.users.upsertByExternalId(ext);
  await ctx.users.setWalletPublicKey(u.id, wallet);
  await ctx.db.insert(depositSources).values({ userId: u.id, sourceWallet: wallet, firstSeenTxSig: `seed-${ext}` });
  await ctx.db.insert(deposits).values({
    txSig: `seed-${ext}`, userId: u.id, amountBaseUnits: String(cashCents * 10000), amountCents: cashCents,
    mint: "USDC", sourceOwner: wallet, destAta: "ATA", slot: 1, status: "credited",
    createdAt: new Date(Date.now() - depositAgeHours * 3600_000),
  });
  await ctx.ledger.credit(u.id, "cash", cashCents, "deposit", `seed-${ext}`);
  return u.id;
}

describe("withdrawals.reserve", () => {
  let ctx: TestCtx;
  let wd: ReturnType<typeof makeWithdrawals>;
  beforeEach(async () => {
    ctx = await makeTestDb();
    wd = makeWithdrawals(ctx.db, ctx.ledger, cfg, async () => 10_000_000_000n);
  });
  afterEach(async () => { await ctx.close(); });

  it("reserves: debits cash, snapshots dest from deposit_sources, queues awaiting_approval (threshold 0)", async () => {
    const userId = await seedFundedUser(ctx, "wallet:did:a", "WALLET_A", 500);
    const r = await wd.reserve(userId, 300);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
    const rows = await ctx.db.select().from(withdrawals).where(eq(withdrawals.id, r.withdrawalId));
    expect(rows[0].status).toBe("awaiting_approval");
    expect(rows[0].destWallet).toBe("WALLET_A");
    expect(rows[0].providerIdempotencyKey).toBe(`withdraw:${r.withdrawalId}`);
  });

  it("rejects amount below min / above max / above settled balance", async () => {
    const userId = await seedFundedUser(ctx, "wallet:did:b", "WALLET_B", 400);
    expect((await wd.reserve(userId, 50)).status).toBe("below_min");
    expect((await wd.reserve(userId, 600)).status).toBe("above_max");
    expect((await wd.reserve(userId, 450)).status).toBe("insufficient");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400);
  });

  it("rejects while a deposit is still within the hold window", async () => {
    const userId = await seedFundedUser(ctx, "wallet:did:c", "WALLET_C", 500, 2);
    expect((await wd.reserve(userId, 200)).status).toBe("held");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("rejects a second concurrent in-flight withdrawal (one-in-flight)", async () => {
    const userId = await seedFundedUser(ctx, "wallet:did:d", "WALLET_D", 500);
    expect((await wd.reserve(userId, 100)).status).toBe("ok");
    expect((await wd.reserve(userId, 100)).status).toBe("in_flight");
    // the rejected second reserve MUST NOT have debited: 500 - 100 (first) = 400, intact
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400);
  });

  it("enforces the per-user 24h cap counting prior confirmed withdrawals", async () => {
    const userId = await seedFundedUser(ctx, "wallet:did:e", "WALLET_E", 5000);
    await ctx.db.insert(withdrawals).values({
      userId, amountCents: 1600, destWallet: "WALLET_E", status: "confirmed", providerIdempotencyKey: "withdraw:prior",
    });
    expect((await wd.reserve(userId, 500)).status).toBe("capped");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(5000);
  });

  it("rejects when treasury solvency precheck fails", async () => {
    const poor = makeWithdrawals(ctx.db, ctx.ledger, cfg, async () => 0n);
    const userId = await seedFundedUser(ctx, "wallet:did:f", "WALLET_F", 500);
    expect((await poor.reserve(userId, 200)).status).toBe("insolvent");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(500);
  });

  it("rejects a user with no confirmed deposit source (cannot withdraw)", async () => {
    const u = await ctx.users.upsertByExternalId("wallet:did:g");
    await ctx.ledger.credit(u.id, "cash", 500, "deposit", "ghost");
    expect((await wd.reserve(u.id, 200)).status).toBe("no_dest");
  });

  it("enforces the GLOBAL 24h cap across users", async () => {
    const userA = await seedFundedUser(ctx, "wallet:did:ga", "WALLET_GA", 500);
    const userB = await seedFundedUser(ctx, "wallet:did:gb", "WALLET_GB", 500);
    // a prior confirmed withdrawal from A sits at 19,800 of the 20,000 global cap (counts globally)
    await ctx.db.insert(withdrawals).values({
      userId: userA, amountCents: 19800, destWallet: "WALLET_GA", status: "confirmed", providerIdempotencyKey: "withdraw:gprior",
    });
    // B's 300 reserve would push global to 20,100 > 20,000 → capped (B is well under the 2000 per-user cap)
    expect((await wd.reserve(userB, 300)).status).toBe("capped");
    expect(await ctx.ledger.balance(userB, "cash")).toBe(500); // nothing debited
  });
});
