import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeRounds, type Rounds } from "./rounds.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";
import { FeedHaltError, OpenRoundExistsError } from "./errors.js";

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
  await ctx.ledger.credit(userId, 100, "dev_grant");
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
    expect(await ctx.ledger.balance(userId)).toBe(90); // 100 - 10 escrowed
  });

  it("HALTs (no debit, no round) when the feed is unhealthy", async () => {
    feed.setHealthy("SOL", false);
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toBeInstanceOf(FeedHaltError);
    expect(await ctx.ledger.balance(userId)).toBe(100);
  });

  it("refuses to open a round the user cannot afford", async () => {
    // drain alice to 5 coins; a valid in-bounds stake of 10 then exceeds the balance
    await ctx.ledger.debit(userId, 95, "test_drain");
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toThrow("insufficient balance");
    expect(await ctx.ledger.balance(userId)).toBe(5);
  });

  it("allows only one open round per user", async () => {
    await rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 });
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 10 })).rejects.toBeInstanceOf(OpenRoundExistsError);
    expect(await ctx.ledger.balance(userId)).toBe(90); // second debit rolled back
  });

  it("validates leverage and stake bounds", async () => {
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 5, stake: 10 })).rejects.toThrow(); // lev < RMIN
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 0 })).rejects.toThrow(); // stake < MIN
    await expect(rounds.open(userId, { asset: "SOL", dir: 1, lev: 50, stake: 99 })).rejects.toThrow(); // stake > MAX
  });
});
