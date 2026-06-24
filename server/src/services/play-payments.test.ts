import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { makePlayPaymentConfirmer } from "./play-payments.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";

function tx(sig: string, opts: Partial<InboundTransfer> = {}): InboundTransfer {
  return {
    txSig: sig,
    slot: 1,
    finalized: true,
    mint: USDC,
    tokenProgram: LEGACY_TOKEN_PROGRAM,
    destAta: ATA,
    sourceOwner: "WALLET_A",
    amountBaseUnits: 250_000n,
    ...opts,
  };
}

describe("makePlayPaymentConfirmer", () => {
  let ctx: TestCtx; let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb({ stakeAsset: "cash" });
    const u = await ctx.users.upsertByExternalId("privy:did:privy:a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
  });
  afterEach(async () => { await ctx.close(); });

  it("credits only the exact payment signature returned by Privy", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 10, maxCents: 500 });
    const source = {
      async fetchInbound() { return [tx("other"), tx("sig-play-123")]; },
    };
    const confirmer = makePlayPaymentConfirmer({ deposits, source, treasuryAta: ATA });

    const out = await confirmer.confirm("sig-play-123");

    expect(out).toEqual({ status: "credited", amountCents: 25 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(25);
  });

  it("returns pending when the exact payment signature is not finalized yet", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 10, maxCents: 500 });
    const source = {
      async fetchInbound() { return [tx("other")]; },
    };
    const confirmer = makePlayPaymentConfirmer({ deposits, source, treasuryAta: ATA });

    const out = await confirmer.confirm("sig-play-123");

    expect(out).toEqual({ status: "pending" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("recovers a finalized payment when Privy sent it but did not return the signature", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 10, maxCents: 500 });
    const source = {
      async fetchInbound() {
        return [
          tx("wrong-source", { sourceOwner: "WALLET_B" }),
          tx("wrong-amount", { amountBaseUnits: 500_000n }),
          tx("sig-recovered"),
        ];
      },
    };
    const confirmer = makePlayPaymentConfirmer({ deposits, source, treasuryAta: ATA });

    const out = await confirmer.recover({ userId, sourceOwner: "WALLET_A", amountCents: 25 });

    expect(out).toEqual({ status: "credited", amountCents: 25 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(25);
  });
});
