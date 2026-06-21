import { env } from "./env.js";
import { createDb } from "./db/client.js";
import { buildServer } from "./http/server.js";
import { makeUsers } from "./services/users.js";
import { makeLedger } from "./services/ledger.js";
import { makeInventory } from "./services/inventory.js";
import { makeRounds } from "./services/rounds.js";
import { makeHermesFeed } from "./feed/hermes.js";
import { makePrivyAuth } from "./auth/privy.js";

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

  const ledger = makeLedger(db);
  // poll rate + HALT tolerance are tunable: the public Hermes REST endpoint can
  // rate-limit a tight 500ms poll, so a too-small stale window flaps into feed_halt.
  const feed = makeHermesFeed({
    assets: ["BTC", "ETH", "SOL"],
    pollMs: Number(process.env.FEED_POLL_MS) || undefined,
    staleMs: Number(process.env.FEED_STALE_MS) || undefined,
  });
  feed.start();
  const rounds = makeRounds({ db, ledger, feed });
  const privyAuth = makePrivyAuth(env);

  const server = buildServer({
    users: makeUsers(db),
    ledger,
    inventory: makeInventory(db),
    rounds,
    feed,
    devEndpoints: env.DEV_ENDPOINTS && env.NODE_ENV !== "production",
    signupFaucet: env.SIGNUP_FAUCET,
    startBalance: env.START_BALANCE,
    corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
    devAuth: env.DEV_AUTH && env.NODE_ENV !== "production",
    privyAuth,
  });

  const addr = await server.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`perps server listening on ${addr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
