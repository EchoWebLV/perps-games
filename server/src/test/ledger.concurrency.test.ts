import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { makeUsers } from "../services/users.js";
import { makeLedger } from "../services/ledger.js";

const URL = process.env.TEST_DATABASE_URL;

// Runs ONLY against a real Postgres (advisory locks + true parallelism).
describe.skipIf(!URL)("ledger overdraft guard under concurrency", () => {
  let raw: Db;
  beforeAll(async () => {
    raw = createDb(URL);
    await raw.runMigrations();
  });
  afterAll(async () => { await raw?.close(); });

  it("N parallel debits at a one-debit balance: exactly one wins, never negative", async () => {
    const users = makeUsers(raw.db);
    const ledger = makeLedger(raw.db);
    const userId = (await users.upsertByExternalId(`dev:race-${process.pid}-${Math.floor(performance.now())}`)).id;
    await ledger.credit(userId, 100, "seed");

    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => ledger.debit(userId, 100, "round_stake")),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1); // exactly one debit succeeds
    expect(await ledger.balance(userId)).toBe(0); // never overdrawn
  });
});
