import { env } from "./env.js";
import { createDb } from "./db/client.js";
import { buildServer } from "./http/server.js";
import { makeUsers } from "./services/users.js";
import { makeLedger } from "./services/ledger.js";
import { makeInventory } from "./services/inventory.js";

async function main(): Promise<void> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required to start the server");
  // fail loud: dev seed endpoints must never be enabled in production
  if (env.DEV_ENDPOINTS && env.NODE_ENV === "production")
    throw new Error("refusing to boot: DEV_ENDPOINTS must not be enabled in production");

  const raw = createDb(env.DATABASE_URL);
  // Auto-migrate is a DEV convenience only. In production, migrations run as an
  // explicit pre-deploy release step (`npm run db:migrate`) — never silently
  // mutate the money tables at app boot. See migrate.ts + the Railway release command.
  if (env.NODE_ENV !== "production") await raw.runMigrations();
  const db = raw.db;

  const server = buildServer({
    users: makeUsers(db),
    ledger: makeLedger(db),
    inventory: makeInventory(db),
    devEndpoints: env.DEV_ENDPOINTS && env.NODE_ENV !== "production",
  });

  const addr = await server.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`perps server listening on ${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
