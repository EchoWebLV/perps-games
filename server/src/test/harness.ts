import { createDb, type Db } from "../db/client.js";
import { makeUsers, type Users } from "../services/users.js";

export interface TestCtx {
  raw: Db;
  db: any;
  users: Users;
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
    close: () => raw.close(),
  };
}
