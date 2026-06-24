import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeReconcile } from "./reconcile.js";

describe("reconcile.solvency", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("reports O ≥ L solvent and O < L as a deficit (player cash only)", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.ledger.credit(u.id, "cash", 300, "deposit", "sig1"); // liabilities = 300¢
    const solvent = makeReconcile(ctx.db, async () => 3_000_000n, ctx.houseUserId); // O = $3.00
    expect(await solvent.solvency()).toMatchObject({ liabilitiesCents: 300, onChainCents: 300, deficitCents: 0, solvent: true });
    const broke = makeReconcile(ctx.db, async () => 1_000_000n, ctx.houseUserId);   // O = $1.00
    expect(await broke.solvency()).toMatchObject({ liabilitiesCents: 300, onChainCents: 100, deficitCents: 200, solvent: false });
  });

  it("excludes the house account from liabilities and reports it as the bankroll", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:b");
    await ctx.ledger.credit(u.id, "cash", 500, "deposit", "sig2");          // player owed $5.00
    await ctx.ledger.credit(ctx.houseUserId, "cash", 1100, "house_seed", "seed-1"); // house bankroll $11.00
    const recon = makeReconcile(ctx.db, async () => 16_000_000n, ctx.houseUserId);   // vault = $16.00
    const s = await recon.solvency();
    expect(s.liabilitiesCents).toBe(500);   // ONLY the player — house excluded
    expect(s.bankrollCents).toBe(1100);
    expect(s.solvent).toBe(true);           // vault $16 ≥ liabilities $5
    expect(s.conserved).toBe(true);         // $16 == $5 players + $11 house
  });

  it("a negative bankroll that leaves the vault below player liabilities flags a deficit", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:c");
    await ctx.ledger.credit(u.id, "cash", 1400, "deposit", "sig3");      // player owed $14.00 (won big)
    await ctx.ledger.post(ctx.houseUserId, "cash", -400, "round_payout_house", "r-1"); // bankroll -$4.00
    const recon = makeReconcile(ctx.db, async () => 10_000_000n, ctx.houseUserId); // vault only $10.00
    const s = await recon.solvency();
    expect(s.bankrollCents).toBe(-400);     // house is underwater
    expect(s.liabilitiesCents).toBe(1400);
    expect(s.onChainCents).toBe(1000);
    expect(s.solvent).toBe(false);          // vault $10 < $14 owed — operator must fund the bankroll
    expect(s.conserved).toBe(true);         // $10 == $14 players + (-$4) house
  });
});
