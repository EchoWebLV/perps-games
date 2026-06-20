import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import * as schema from "./schema.js";

const MIGRATIONS = "./drizzle";

export interface Db {
  /** Drizzle query interface (driver-agnostic) */
  db: any;
  /** apply SQL migrations from ./drizzle */
  runMigrations(): Promise<void>;
  /** release connections */
  close(): Promise<void>;
  driver: "postgres" | "pglite";
}

/**
 * createDb(url) -> real Postgres via postgres.js.
 * createDb() (no url) -> in-process PGlite (tests / ephemeral dev).
 */
export function createDb(url?: string): Db {
  if (url) {
    const client = postgres(url, { max: 10 });
    const db = drizzlePg(client, { schema });
    return {
      db,
      driver: "postgres",
      runMigrations: () => migratePg(db, { migrationsFolder: MIGRATIONS }),
      close: () => client.end(),
    };
  }
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  return {
    db,
    driver: "pglite",
    runMigrations: () => migratePglite(db, { migrationsFolder: MIGRATIONS }),
    close: () => client.close(),
  };
}
