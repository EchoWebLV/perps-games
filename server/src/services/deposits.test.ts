import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { depositSources } from "../db/schema.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";
const cfg = { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 };

function transfer(over: Partial<InboundTransfer> = {}): InboundTransfer {
  return {
    txSig: "sig1", slot: 10, finalized: true, mint: USDC, tokenProgram: LEGACY_TOKEN_PROGRAM,
    destAta: ATA, sourceOwner: "WALLET_A", amountBaseUnits: 2_000_000n, ...over,
  };
}

describe("deposits.recordInbound", () => {
  let ctx: TestCtx;
  let deposits: ReturnType<typeof makeDeposits>;
  let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    const u = await ctx.users.upsertByExternalId("wallet:did:deposit-a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
    deposits = makeDeposits(ctx.db, ctx.ledger, cfg);
  });
  afterEach(async () => { await ctx.close(); });

  it("credits cash for a valid transfer from a bound wallet", async () => {
    const r = await deposits.recordInbound(transfer());
    expect(r).toEqual({ status: "credited", userId, amountCents: 200 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(0);
  });

  it("is idempotent — replaying the same tx_sig does not double-credit", async () => {
    await deposits.recordInbound(transfer());
    const again = await deposits.recordInbound(transfer());
    expect(again).toEqual({ status: "duplicate" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("quarantines sub-cent dust (never rounds)", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "d", amountBaseUnits: 2_000_001n }));
    expect(r).toEqual({ status: "quarantine", reason: "sub_cent_dust" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("quarantines wrong mint, wrong program, wrong dest, and out-of-bounds", async () => {
    expect((await deposits.recordInbound(transfer({ txSig: "m", mint: "OTHER" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "p", tokenProgram: "Tokenz" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "x", destAta: "ELSEWHERE" }))).status).toBe("quarantine");
    expect((await deposits.recordInbound(transfer({ txSig: "hi", amountBaseUnits: 9_999_999n }))).status).toBe("quarantine");
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("quarantines a transfer from an unbound wallet (unknown source)", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "u", sourceOwner: "STRANGER" }));
    expect(r).toEqual({ status: "quarantine", reason: "unknown_source" });
  });

  it("a second deposit from the same wallet credits the same user; deposit_sources stays one row", async () => {
    await deposits.recordInbound(transfer());
    const r2 = await deposits.recordInbound(transfer({ txSig: "sig2" }));
    expect(r2).toEqual({ status: "credited", userId, amountCents: 200 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400);
    const rows = await ctx.db.select().from(depositSources).where(eq(depositSources.sourceWallet, "WALLET_A"));
    expect(rows).toHaveLength(1);
  });

  it("quarantines if the funding wallet is already bound to ANOTHER account (sybil guard)", async () => {
    const other = await ctx.users.upsertByExternalId("wallet:did:deposit-b");
    await ctx.db.insert(depositSources).values({ userId: other.id, sourceWallet: "WALLET_A", firstSeenTxSig: "old" });
    const r = await deposits.recordInbound(transfer({ txSig: "syb" }));
    expect(r).toEqual({ status: "quarantine", reason: "source_bound_other" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });

  it("ignores a not-yet-finalized transfer without recording it", async () => {
    const r = await deposits.recordInbound(transfer({ txSig: "nf", finalized: false }));
    expect(r).toEqual({ status: "quarantine", reason: "not_finalized" });
  });

  // The token-program check is a chain-agnostic label match: the EVM rail labels ERC-20
  // transfers "erc20" while the Solana rail keeps the legacy SPL program id by default.
  it("accepts a transfer whose tokenProgram matches a configured expected label", async () => {
    const svc = makeDeposits(ctx.db, ctx.ledger, { ...cfg, expectedTokenProgram: "erc20" });
    const r = await svc.recordInbound(transfer({ txSig: "evm", tokenProgram: "erc20" }));
    expect(r).toEqual({ status: "credited", userId, amountCents: 200 });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("quarantines the legacy Solana program id when an EVM label is configured", async () => {
    const svc = makeDeposits(ctx.db, ctx.ledger, { ...cfg, expectedTokenProgram: "erc20" });
    const r = await svc.recordInbound(transfer({ txSig: "spl-on-evm", tokenProgram: LEGACY_TOKEN_PROGRAM }));
    expect(r).toEqual({ status: "quarantine", reason: "wrong_program" });
    expect(await ctx.ledger.balance(userId, "cash")).toBe(0);
  });
});
