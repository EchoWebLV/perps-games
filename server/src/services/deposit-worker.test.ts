import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { makeDepositConfirmer } from "./deposit-worker.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";

function tx(sig: string): InboundTransfer {
  return { txSig: sig, slot: 1, finalized: true, mint: USDC, tokenProgram: LEGACY_TOKEN_PROGRAM, destAta: ATA, sourceOwner: "WALLET_A", amountBaseUnits: 1_000_000n };
}

describe("makeDepositConfirmer.tick", () => {
  let ctx: TestCtx; let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    const u = await ctx.users.upsertByExternalId("wallet:did:deposit-worker-a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
  });
  afterEach(async () => { await ctx.close(); });

  it("processes newest→oldest and credits each once, then advances its cursor", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    const pending = [tx("s2"), tx("s1")]; // source returns newest-first
    const source = {
      async fetchInbound({ untilSig }: { untilSig?: string }) {
        return untilSig === "s2" ? [] : pending;
      },
      async fetchMintInfo() { return { decimals: 6, programAddress: LEGACY_TOKEN_PROGRAM }; },
      async readTreasuryBaseUnits() { return 0n; },
    };
    const confirmer = makeDepositConfirmer({ deposits, source, treasuryAta: ATA, pollMs: 1000 });
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200); // 2 × $1.00
    await confirmer.tick(); // cursor now at s2 → source returns [] → no double-credit
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });
});
