# Perps Raider — Backend

Stateful Node/TypeScript (Fastify) service. Authoritative coin ledger + car inventory.

## Run locally

Postgres via Docker:
```bash
docker run --name perps-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=perps -p 5432:5432 -d postgres:16
```
(or use a local Postgres and point `DATABASE_URL` at it)

Then:
```bash
cd server
cp .env.example .env          # edit DATABASE_URL if needed
npm install
npm run db:generate           # only after schema changes
npm run dev                    # migrates on boot (dev only), then serves on :8080
```

Smoke test:
```bash
curl localhost:8080/healthz
curl -H 'x-dev-user: alice' localhost:8080/v1/me
curl -H 'x-dev-user: alice' -H 'content-type: application/json' \
     -d '{"amount":500}' localhost:8080/v1/dev/grant-coins
```

## Test
```bash
npm test                       # in-process pglite, no Postgres needed
npm run test:concurrency       # needs TEST_DATABASE_URL=<real postgres> (overdraft race)
```

## Deploy (Railway)
- New Railway project → add a **Postgres** plugin (sets `DATABASE_URL`).
- Add this `server/` as a service (root directory `server`).
- Set `DEV_ENDPOINTS=false` and `NODE_ENV=production`.
- **Pre-deploy / release command:** `npm run db:migrate` (migrations run as an explicit step — NOT at app boot in production).
- Start command: `npm run start`.
- **Before any real value:** run an **off-platform** backup (`pg_dump` → S3/R2 on a schedule, independent of the Railway dashboard), set **spend alerts**, and evaluate Render (managed Postgres + PITR + SLA) at the Beta money gate. Money migrations must be **additive / expand-contract** (drizzle-kit has no down-migrations).
