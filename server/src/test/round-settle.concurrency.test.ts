import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { makeUsers } from "../services/users.js";
import { makeLedger } from "../services/ledger.js";
import { makeRounds, type Rounds } from "../services/rounds.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("concurrent double-close settles exactly once", () => {
  let raw: Db;
  let rounds: Rounds;
  let feed: StubFeed;
  let userId: string;
  let ledger: ReturnType<typeof makeLedger>;

  beforeAll(async () => {
    raw = createDb(URL);
    await raw.runMigrations();
    const users = makeUsers(raw.db);
    ledger = makeLedger(raw.db);
    feed = makeStubFeed({ SOL: { price: 100, tsUs: 1_000_000 } });
    rounds = makeRounds({ db: raw.db, ledger, feed });
    const u = await users.upsertByExternalId(`dev:conc-${Date.now()}`);
    userId = u.id;
    await ledger.credit(userId, "coin", 100, "dev_grant");
  });

  afterAll(async () => {
    await raw.close();
  });

  it("credits the payout once under two parallel closes", async () => {
    const r = await rounds.open(userId, { asset: "SOL", dir: 1, lev: 10, stake: 10 });
    feed.set("SOL", { price: 105, tsUs: 5_000_000 });
    const before = await ledger.balance(userId, "coin"); // 90
    const [a, b] = await Promise.all([
      rounds.close(userId, r.id, "cashout"),
      rounds.close(userId, r.id, "cashout"),
    ]);
    expect(a.payoutCoins).toBe(b.payoutCoins); // both observe the same settlement
    const after = await ledger.balance(userId, "coin");
    expect(after).toBe(before + a.payoutCoins); // credited exactly once, not twice
  });
});
