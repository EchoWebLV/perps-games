import { createDb, type Db } from "../db/client.js";
import { makeUsers, type Users } from "../services/users.js";
import { makeLedger, type Ledger } from "../services/ledger.js";
import { makeInventory, type Inventory } from "../services/inventory.js";
import { buildServer } from "../http/server.js";

export interface TestCtx {
  raw: Db;
  db: any;
  users: Users;
  ledger: Ledger;
  inventory: Inventory;
  server: ReturnType<typeof buildServer>;
  close(): Promise<void>;
}

/** fresh in-memory pglite DB with migrations applied + services wired */
export async function makeTestDb(): Promise<TestCtx> {
  const raw = createDb(); // pglite
  await raw.runMigrations();
  const db = raw.db;
  return {
    raw,
    db,
    users: makeUsers(db),
    ledger: makeLedger(db),
    inventory: makeInventory(db),
    server: buildServer({
      users: makeUsers(db),
      ledger: makeLedger(db),
      inventory: makeInventory(db),
      devEndpoints: true,
    }),
    close: () => raw.close(),
  };
}
