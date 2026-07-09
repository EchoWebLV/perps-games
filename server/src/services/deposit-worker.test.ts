import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeDeposits, type InboundTransfer } from "./deposits.js";
import { makeDepositConfirmer, makeDbDepositCursorStore } from "./deposit-worker.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ATA = "TREASURYata1111111111111111111111111111111";

function transfer(sig: string): InboundTransfer {
  return { txSig: sig, slot: 1, finalized: true, mint: USDC, tokenProgram: LEGACY_TOKEN_PROGRAM, destAta: ATA, sourceOwner: "WALLET_A", amountBaseUnits: 1_000_000n };
}

/** one entry per on-chain signature, NEWEST-FIRST. `transfer: null` = a dust / non-deposit signature. */
type StreamSig = { sig: string; transfer: InboundTransfer | null };

/** in-memory DepositSource that paginates a newest-first signature stream like getSignaturesForAddress. */
function makeMockSource(stream: StreamSig[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async fetchInbound({ untilSig, beforeSig, limit = 100 }: { treasuryAta: string; untilSig?: string; beforeSig?: string; limit?: number }) {
      calls++;
      let start = 0;
      if (beforeSig) {
        const i = stream.findIndex((s) => s.sig === beforeSig);
        start = i < 0 ? stream.length : i + 1; // strictly older than beforeSig
      }
      let end = stream.length;
      if (untilSig) {
        const j = stream.findIndex((s) => s.sig === untilSig);
        if (j >= 0) end = j; // exclusive: only signatures NEWER than untilSig
      }
      const slice = stream.slice(start, Math.min(end, start + limit));
      return {
        transfers: slice.filter((s) => s.transfer).map((s) => s.transfer!),
        newestSig: slice.length ? slice[0].sig : null,
        oldestSig: slice.length ? slice[slice.length - 1].sig : null,
        full: slice.length === limit,
      };
    },
    async fetchMintInfo() { return { decimals: 6, programAddress: LEGACY_TOKEN_PROGRAM }; },
    async readTreasuryBaseUnits() { return 0n; },
  };
}

describe("makeDepositConfirmer.tick (persistent cursor + pagination)", () => {
  let ctx: TestCtx; let userId: string;
  beforeEach(async () => {
    ctx = await makeTestDb();
    const u = await ctx.users.upsertByExternalId("wallet:did:deposit-worker-a");
    await ctx.users.setWalletPublicKey(u.id, "WALLET_A");
    userId = u.id;
  });
  afterEach(async () => { await ctx.close(); });

  it("processes oldest→newest, credits each once, and persists its cursor", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    const store = makeDbDepositCursorStore(ctx.db);
    const source = makeMockSource([{ sig: "s2", transfer: transfer("s2") }, { sig: "s1", transfer: transfer("s1") }]);
    const confirmer = makeDepositConfirmer({ deposits, source, store, treasuryAta: ATA, pollMs: 1000 });
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200); // 2 × $1.00
    expect(await store.get(ATA)).toBe("s2"); // cursor persisted at the newest signature
    await confirmer.tick(); // cursor at s2 → nothing newer → no double-credit
    expect(await ctx.ledger.balance(userId, "cash")).toBe(200);
  });

  it("fully processes a burst larger than one page (paginates; nothing skipped)", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    const store = makeDbDepositCursorStore(ctx.db);
    // 150 real deposits, newest-first (index 0 = s150 newest … index 149 = s1 oldest)
    const stream = Array.from({ length: 150 }, (_, i) => { const n = 150 - i; return { sig: `s${n}`, transfer: transfer(`s${n}`) }; });
    const source = makeMockSource(stream);
    const confirmer = makeDepositConfirmer({ deposits, source, store, treasuryAta: ATA, pollMs: 1000 });
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(150 * 100); // all 150 credited — none pushed out of the 100-window
    expect(source.calls).toBeGreaterThanOrEqual(2); // it paged past the first 100
    expect(await store.get(ATA)).toBe("s150");
  });

  it("resumes from the persisted cursor after a simulated restart (only new deposits, no re-credit)", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    const stream: StreamSig[] = [{ sig: "s3", transfer: transfer("s3") }, { sig: "s2", transfer: transfer("s2") }, { sig: "s1", transfer: transfer("s1") }];
    const source = makeMockSource(stream);
    const confirmer1 = makeDepositConfirmer({ deposits, source, store: makeDbDepositCursorStore(ctx.db), treasuryAta: ATA, pollMs: 1000 });
    await confirmer1.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(300);

    // a newer deposit arrives, then the process "restarts": a FRESH confirmer + store (no in-memory cursor)
    stream.unshift({ sig: "s4", transfer: transfer("s4") });
    const confirmer2 = makeDepositConfirmer({ deposits, source, store: makeDbDepositCursorStore(ctx.db), treasuryAta: ATA, pollMs: 1000 });
    await confirmer2.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(400); // only s4 credited; s1..s3 resumed-past, not re-credited
  });

  it("records a real deposit interleaved with dust and advances past the dust", async () => {
    const deposits = makeDeposits(ctx.db, ctx.ledger, { usdcMint: USDC, treasuryAta: ATA, minCents: 100, maxCents: 500 });
    const store = makeDbDepositCursorStore(ctx.db);
    const stream: StreamSig[] = [
      { sig: "d1", transfer: null }, // dust (newest)
      { sig: "r1", transfer: transfer("r1") }, // the real deposit
      { sig: "d2", transfer: null }, // dust (oldest)
    ];
    const source = makeMockSource(stream);
    const confirmer = makeDepositConfirmer({ deposits, source, store, treasuryAta: ATA, pollMs: 1000 });
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(100); // real deposit recorded despite the surrounding dust
    expect(await store.get(ATA)).toBe("d1"); // cursor advanced past the dust to the newest raw signature
    await confirmer.tick();
    expect(await ctx.ledger.balance(userId, "cash")).toBe(100); // no reprocessing
  });
});
