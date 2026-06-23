import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeReconcile } from "./reconcile.js";

describe("reconcile.solvency", () => {
  let ctx: TestCtx;
  beforeEach(async () => { ctx = await makeTestDb(); });
  afterEach(async () => { await ctx.close(); });

  it("reports O ≥ L solvent and O < L as a deficit", async () => {
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.ledger.credit(u.id, "cash", 300, "deposit", "sig1"); // L = 300¢
    const solvent = makeReconcile(ctx.db, async () => 3_000_000n); // O = $3.00
    expect(await solvent.solvency()).toMatchObject({ ledgerCents: 300, onChainCents: 300, deficitCents: 0, healthy: true });
    const broke = makeReconcile(ctx.db, async () => 1_000_000n);   // O = $1.00
    expect(await broke.solvency()).toMatchObject({ ledgerCents: 300, onChainCents: 100, deficitCents: 200, healthy: false });
  });
});
