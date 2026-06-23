import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeRounds, type Rounds } from "./rounds.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";
import { FeedHaltError, OpenRoundExistsError, RoundNotFoundError } from "./errors.js";

let ctx: TestCtx;
let feed: StubFeed;
let rounds: Rounds;
let userId: string;

beforeEach(async () => {
  ctx = await makeTestDb();
  feed = makeStubFeed({ SOL: { price: 100, tsUs: 1_000_000 } });
  rounds = makeRounds({ db: ctx.db, ledger: ctx.ledger, feed });
  const u = await ctx.users.upsertByExternalId("dev:alice");
  userId = u.id;
  await ctx.ledger.credit(userId, "coin", 100, "dev_grant");
});

afterEach(async () => {
  await ctx.close();
});

describe("rounds.open", () => {
  it("escrows the stake and creates an open round with the server-stamped entry", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    expect(r.status).toBe("open");
    expect(r.entryRaw).toBe(100); // server feed, not client-supplied
    expect(r.stake).toBe(10);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(90); // 100 - 10 escrowed
  });

  it("HALTs (no debit, no round) when the feed is unhealthy", async () => {
    feed.setHealthy("SOL", false);
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toBeInstanceOf(FeedHaltError);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(100);
  });

  it("refuses to open a round the user cannot afford", async () => {
    // drain alice to 5 coins; a valid in-bounds stake of 10 then exceeds the balance
    await ctx.ledger.debit(userId, "coin", 95, "test_drain");
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toThrow("insufficient balance");
    expect(await ctx.ledger.balance(userId, "coin")).toBe(5);
  });

  it("allows only one open round per user", async () => {
    await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toBeInstanceOf(OpenRoundExistsError);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(90); // second debit rolled back
  });

  it("validates leverage and stake bounds", async () => {
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 5, stake: 10 })).rejects.toThrow(); // lev < RMIN
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 0 })).rejects.toThrow(); // stake < MIN
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 5001 })).rejects.toThrow(); // stake > MAX
  });

  it("accepts a cent-denominated stake up to $50.00 (5000 coins) and rejects above it", async () => {
    await ctx.ledger.credit(userId, "coin", 5000, "topup"); // afford a $50 stake → balance 5100
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 5000 });
    expect(r.stake).toBe(5000);
    await rounds.close(userId, r.id, "cashout"); // clear the open round
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 5001 })).rejects.toThrow(); // > $50 cap
  });
});

describe("rounds.action", () => {
  it("records a flip with the SERVER-stamped price (not client-supplied)", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    feed.set("SOL", { price: 110, tsUs: 1_500_000 });
    const after = await rounds.action(userId, r.id, { actionId: "a1", kind: "flip", dir: -1 });
    expect(after.actions).toHaveLength(1);
    expect(after.actions[0]).toMatchObject({ kind: "flip", dir: -1, priceRaw: 110, seq: 1 });
  });

  it("records a leverage change", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    feed.set("SOL", { price: 101, tsUs: 1_500_000 });
    const after = await rounds.action(userId, r.id, { actionId: "a1", kind: "lever", lev: 200 });
    expect(after.actions[0]).toMatchObject({ kind: "lever", lev: 200, seq: 1 });
  });

  it("is idempotent on actionId (a retry posts nothing)", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    feed.set("SOL", { price: 110, tsUs: 1_500_000 });
    await rounds.action(userId, r.id, { actionId: "dup", kind: "flip", dir: -1 });
    const after = await rounds.action(userId, r.id, { actionId: "dup", kind: "flip", dir: -1 });
    expect(after.actions).toHaveLength(1); // not 2
  });

  it("HALTs an action on a stale feed", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    feed.setHealthy("SOL", false);
    await expect(rounds.action(userId, r.id, { actionId: "a1", kind: "flip", dir: -1 })).rejects.toBeInstanceOf(FeedHaltError);
  });

  it("rejects an action on an unknown round", async () => {
    await expect(rounds.action(userId, "00000000-0000-0000-0000-000000000000", { actionId: "a1", kind: "flip", dir: -1 })).rejects.toBeInstanceOf(RoundNotFoundError);
  });
});

describe("rounds.close", () => {
  it("happy path: settles a winning round and pays out", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 }); // +5% * 10x = +50% → eq 1.5
    const res = await rounds.close(userId, r.id, "cashout");
    expect(res.outcome).toBe("cashout");
    expect(res.equity).toBeCloseTo(1.5, 9);
    expect(res.payoutCoins).toBe(Math.floor(10 * 1.5 * 0.95)); // 14
    expect(await ctx.ledger.balance(userId, "coin")).toBe(90 + 14); // -10 stake +14 payout
  });

  it("a liquidated close pays nothing and writes no payout entry", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 91, tsUs: 5_000_000 }); // eq 0.1 ≤ LIQ
    const res = await rounds.close(userId, r.id, "cashout");
    expect(res.outcome).toBe("liq");
    expect(res.payoutCoins).toBe(0);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(90); // stake forfeited, no credit
  });

  it("settles 'time' when the cap elapsed", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 101, tsUs: 1_000_000 + 61_000_000 }); // +61s
    const res = await rounds.close(userId, r.id, "expire");
    expect(res.outcome).toBe("time");
  });

  it("a mid-round flip is reflected in the settlement (segment-replay)", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 110, tsUs: 3_000_000 }); // bank +1.0 on the long
    await rounds.action(userId, r.id, { actionId: "flip1", kind: "flip", dir: -1 });
    feed.set("SOL", { price: 105, tsUs: 6_000_000 }); // short gains as price falls
    const res = await rounds.close(userId, r.id, "cashout");
    expect(res.equity).toBeGreaterThan(2.4); // banked 1.0 + short profit
    expect(res.payoutCoins).toBeGreaterThan(10);
  });

  it("double-close is idempotent: same result, paid once", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const first = await rounds.close(userId, r.id, "cashout");
    const second = await rounds.close(userId, r.id, "cashout");
    expect(second.outcome).toBe(first.outcome);
    expect(second.payoutCoins).toBe(first.payoutCoins);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(90 + first.payoutCoins); // credited once
  });

  it("HALTs a close on a stale feed and leaves the round open", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.setHealthy("SOL", false);
    await expect(rounds.close(userId, r.id, "cashout")).rejects.toBeInstanceOf(FeedHaltError);
    // recover and settle
    feed.setHealthy("SOL", true);
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const res = await rounds.close(userId, r.id, "cashout");
    expect(res.outcome).toBe("cashout");
  });

  it("rejects closing an unknown round", async () => {
    await expect(rounds.close(userId, "00000000-0000-0000-0000-000000000000", "cashout")).rejects.toBeInstanceOf(RoundNotFoundError);
  });
});

describe("close settles at the last shown mark (see == get)", () => {
  it("settles at the last mark's price, not a newer feed tick", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 }); // +5% * 10x → eq 1.5
    const m = await rounds.mark(userId, r.id);          // the client "sees" eq 1.5
    expect(m.equity).toBeCloseTo(1.5, 9);
    feed.set("SOL", { price: 130, tsUs: 6_000_000 });   // price JUMPS after the mark
    const res = await rounds.close(userId, r.id, "cashout");
    expect(res.round.exitRaw).toBe(105);                // settled at what was shown, not 130
    expect(res.equity).toBeCloseTo(1.5, 9);
  });

  it("falls back to a fresh feed read when no mark was taken", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const res = await rounds.close(userId, r.id, "cashout"); // never marked
    expect(res.round.exitRaw).toBe(105);
    expect(res.equity).toBeCloseTo(1.5, 9);
  });

  it("falls back to a fresh read when the last mark is stale", async () => {
    let t = 1000;
    const rounds2 = makeRounds({ db: ctx.db, ledger: ctx.ledger, feed, nowMs: () => t });
    const r = await rounds2.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    await rounds2.mark(userId, r.id);                   // mark recorded at t=1000
    t = 1000 + 5000;                                    // 5s later → stale
    feed.set("SOL", { price: 130, tsUs: 6_000_000 });
    const res = await rounds2.close(userId, r.id, "cashout");
    expect(res.round.exitRaw).toBe(130);               // fresh, because the mark went stale
  });
});

describe("rounds.mark", () => {
  it("returns the current equity/payout WITHOUT closing the round", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 }); // +5% * 10x → eq 1.5
    const m = await rounds.mark(userId, r.id);
    expect(m.status).toBe("open");
    expect(m.stale).toBe(false);
    expect(m.equity).toBeCloseTo(1.5, 9);
    expect(m.payoutCoins).toBe(Math.floor(10 * 1.5 * 0.95)); // 14
    expect(await rounds.getOpenRoundId(userId)).toBe(r.id); // still open
  });

  it("reflects a mid-round flip (same segment-replay as settle)", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 110, tsUs: 3_000_000 });
    await rounds.action(userId, r.id, { actionId: "f1", kind: "flip", dir: -1 });
    feed.set("SOL", { price: 105, tsUs: 6_000_000 });
    const m = await rounds.mark(userId, r.id);
    expect(m.equity).toBeGreaterThan(2.4);
  });

  it("flags stale on an unhealthy feed and leaves the round open", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.setHealthy("SOL", false);
    const m = await rounds.mark(userId, r.id);
    expect(m.stale).toBe(true);
    expect(await rounds.getOpenRoundId(userId)).toBe(r.id);
  });

  it("returns the stored result for an already-settled round (matches close)", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const closed = await rounds.close(userId, r.id, "cashout");
    const m = await rounds.mark(userId, r.id);
    expect(m.status).toBe("settled");
    expect(m.equity).toBeCloseTo(closed.equity, 9);
    expect(m.payoutCoins).toBe(closed.payoutCoins);
  });
});

describe("rounds.getOpenRoundId", () => {
  it("getOpenRoundId returns the user's open round, or null", async () => {
    expect(await rounds.getOpenRoundId(userId)).toBeNull();
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 5 });
    expect(await rounds.getOpenRoundId(userId)).toBe(r.id);
    await rounds.close(userId, r.id, "cashout");
    expect(await rounds.getOpenRoundId(userId)).toBeNull();
  });
});
