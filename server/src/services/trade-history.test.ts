import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeTradeHistory } from "./trade-history.js";

const input = (id: string) => ({
  id,
  asset: "SOL" as const,
  dir: 1 as const,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150.25,
  exitPrice: 151.5,
  openedAt: new Date("2026-07-10T10:00:00.000Z"),
  outcome: "cashout" as const,
  payoutBase: 11_000_000,
});

describe("trade history service", () => {
  let ctx: TestCtx;

  afterEach(async () => {
    await ctx?.close();
  });

  it("derives the bound wallet and inserts a UUID idempotently", async () => {
    ctx = await makeTestDb();
    const user = await ctx.users.upsertByExternalId("wallet:alice");
    await ctx.users.setWalletPublicKey(user.id, "AliceWallet");
    const history = makeTradeHistory({
      db: ctx.db,
      users: ctx.users,
      now: () => new Date("2026-07-10T10:01:00.000Z"),
    });

    const first = await history.record(user.id, input("11111111-1111-4111-8111-111111111111"));
    const replay = await history.record(user.id, input("11111111-1111-4111-8111-111111111111"));

    expect(replay).toEqual(first);
    expect(first.walletPublicKey).toBe("AliceWallet");
    expect(first.pnlBase).toBe(1_000_000);
    expect((await history.list(user.id, undefined, 25)).items).toHaveLength(1);
  });

  it("paginates newest first without exposing another user", async () => {
    ctx = await makeTestDb();
    const alice = await ctx.users.upsertByExternalId("wallet:alice-page");
    const bob = await ctx.users.upsertByExternalId("wallet:bob-page");
    await ctx.users.setWalletPublicKey(alice.id, "AlicePageWallet");
    await ctx.users.setWalletPublicKey(bob.id, "BobPageWallet");
    let tick = 0;
    const history = makeTradeHistory({
      db: ctx.db,
      users: ctx.users,
      now: () => new Date(1_700_000_000_000 + tick++ * 1000),
    });
    await history.record(alice.id, input("11111111-1111-4111-8111-111111111111"));
    await history.record(alice.id, input("22222222-2222-4222-8222-222222222222"));
    await history.record(alice.id, input("33333333-3333-4333-8333-333333333333"));
    await history.record(bob.id, input("44444444-4444-4444-8444-444444444444"));

    const page1 = await history.list(alice.id, undefined, 2);
    const page2 = await history.list(alice.id, page1.nextCursor ?? undefined, 2);
    expect(page1.items.map((row) => row.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(page2.items.map((row) => row.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(page2.nextCursor).toBeNull();
  });
});
