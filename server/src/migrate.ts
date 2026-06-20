import { env } from "./env.js";
import { createDb } from "./db/client.js";

if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required to migrate");
const raw = createDb(env.DATABASE_URL);
await raw.runMigrations();
await raw.close();
console.log("migrations applied");
