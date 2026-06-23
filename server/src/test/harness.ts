import { createDb, type Db } from "../db/client.js";
import { makeUsers, type Users } from "../services/users.js";
import { makeLedger, type Ledger } from "../services/ledger.js";
import { makeInventory, type Inventory } from "../services/inventory.js";
import { makeRounds, type Rounds } from "../services/rounds.js";
import { makeStubFeed, type StubFeed } from "../feed/stub.js";
import { buildServer } from "../http/server.js";

export interface TestCtx {
  raw: Db;
  db: any;
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  rounds: Rounds;
  feed: StubFeed;
  server: ReturnType<typeof buildServer>;
  close(): Promise<void>;
}

/** fresh in-memory pglite DB with migrations applied + services wired (stub feed) */
export async function makeTestDb(opts: { signupFaucet?: boolean; startBalance?: number; corsOrigins?: string[]; devAuth?: boolean; privyAuth?: import("../auth/privy.js").PrivyAuth | null; realMoney?: { enabled: boolean; treasuryUsdcAta: string | null } } = {}): Promise<TestCtx> {
  const raw = createDb(); // pglite
  await raw.runMigrations();
  const db = raw.db;

  const users = makeUsers(db);
  const ledger = makeLedger(db);
  const inventory = makeInventory(db);
  const feed = makeStubFeed();
  const rounds = makeRounds({ db, ledger, feed });

  const server = buildServer({
    users, ledger, inventory, rounds, feed,
    devEndpoints: true,
    signupFaucet: opts.signupFaucet ?? false,
    startBalance: opts.startBalance ?? 100,
    corsOrigins: opts.corsOrigins ?? ["http://localhost:3000"],
    devAuth: opts.devAuth ?? true,
    privyAuth: opts.privyAuth ?? null,
    realMoney: opts.realMoney ?? { enabled: false, treasuryUsdcAta: null },
  });

  return { raw, db, users, ledger, inventory, rounds, feed, server, close: () => raw.close() };
}
