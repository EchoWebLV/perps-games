# Perps Rider — Backend

Stateful Node/TypeScript (Fastify) service. Authoritative coin ledger + car inventory.

## Workspace installation

Install dependencies from the repository root with `npm install`. The root
`package-lock.json` is the canonical lockfile for the npm workspace, including
`@perps/server`; the standalone `server/package-lock.json` is not an installation source.

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

## Live paddock WebSocket

The browser uses the same `VITE_API_BASE` host for HTTP and live paddock presence.
It converts `http` to `ws` and `https` to `wss`, then connects to
`/v1/presence`. No additional public WebSocket environment variable is required.

In deployed environments, the reverse proxy in front of this service must allow
WebSocket upgrade requests on `/v1/presence` and keep them routed to the same
backend service as the HTTP API.

## Deploy (Railway)
- New Railway project → add a **Postgres** plugin (sets `DATABASE_URL`).
- Add this `server/` as a service (root directory `server`).
- Set `DEV_ENDPOINTS=false` and `NODE_ENV=production`.
- **Pre-deploy / release command:** `npm run db:migrate` (migrations run as an explicit step — NOT at app boot in production).
- Start command: `npm run start`.
- **Before any real value:** run an **off-platform** backup (`pg_dump` → S3/R2 on a schedule, independent of the Railway dashboard), set **spend alerts**, and evaluate Render (managed Postgres + PITR + SLA) at the Beta money gate. Money migrations must be **additive / expand-contract** (drizzle-kit has no down-migrations).
