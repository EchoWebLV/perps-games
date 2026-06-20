# Pillar 1.5 — Client → server cutover (round-money) — design

**Date:** 2026-06-21
**Status:** approved (design dialogue complete) — ready for `writing-plans`
**Branch:** redline-3d
**Pillar:** 1.5 (A/J) — depends on 1.2 (built)
**Scope:** the **round-money cutover only**. The web/desktop surface (keyboard/mouse/gamepad,
landscape, Desktop-HIGH tier, installable PWA) is split into a separate **1.5b** spec.

---

## Why

Pillars 1.1 (ledger) and 1.2 (server-side authoritative settlement) are **built and verified**, but
**nothing uses them**. The client at [`src/main.ts`](../../../src/main.ts) still runs a local
`RoundEngine` + `SimSettlement` and the only network call is the Hermes price feed — so the backend is
dead code from the player's perspective. This pillar makes the built backend **real**: the client
drives `/v1/round/*` and the **server ledger becomes the single source of truth** for the stake/payout
balance.

MagicBlock (fork 7) does **not** touch this pillar — the round engine stays off-chain, so the cutover
is unaffected.

## Current state (the seam we're building into)

- The client makes **zero** server calls today except the price feed. No API client exists — greenfield.
- `controls.stake()` already returns an **integer 1–50**; `controls.dir()` returns **1/-1** — both
  match `/v1/round/open` exactly. `asset` is `"BTC"|"ETH"|"SOL"` — matches the server enum.
- Server: Fastify on **:8080**, **no CORS** dependency installed, dev endpoints env-gated
  (`DEV_ENDPOINTS && NODE_ENV !== "production"`). Vite dev on **:3000**, no proxy.
- Auth is the **`x-dev-user`** header stub (Privy is Pillar 1.3).

### The server contract (already built — used as-is)

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /v1/me` | — | `{userId, balance, cars}` | 401 |
| `POST /v1/round/open` | `{asset, dir:1\|-1, lev:int[10,1000], stake:int[1,50]}` | `{roundId, asset, dir, lev, stake, entryRaw, entryTsUs}` | 402 `insufficient_balance`, 409 `round_already_open`, 503 `feed_halt`, 400 |
| `POST /v1/round/action` | `{roundId:uuid, actionId, kind:"flip"\|"lever", dir?, lev?}` | `{roundId, status, actionCount}` | 404 `round_not_found`, 409 `round_not_open`, 503 `feed_halt`, 400 |
| `POST /v1/round/close` | `{roundId:uuid, reason:"cashout"\|"expire"}` | `{outcome, payoutCoins, pnlCoins, equity, exitRaw, balance}` | 404 `round_not_found`, 503 `feed_halt`, 400 |
| `GET /v1/round/:id` | — | the round row | 404 |

All behind `requireUser` (the `x-dev-user` header). `close` is idempotent (concurrent double-close →
single credit, verified on real Postgres); `action` is idempotent on `(roundId, actionId)`; settlement
is **single-writer** and **marks-only**.

## The three impedance mismatches (what makes this a design, not a wiring task)

1. **Continuous leverage → discrete server actions.** The throttle maps log-scale across ~60 distinct
   `niceLev` values from 10→1000, and a full gas burst (throttle 34→100) takes ~1.3s. Per-frame or
   per-`niceLev`-change streaming is untenable. → **Time-coalesce**: send the current leverage at most
   every **~200ms**, and only when it changed.
2. **Per-tick client liquidation → marks-only server settlement.** The client `RoundEngine.tick`
   liquidates the instant equity ≤ LIQ; the server `settleRound` only evaluates terminal conditions at
   the marks it stamped (open, each action, exit) — continuous liq is explicitly the deferred 1.4
   settler worker's job. → The local engine is **prediction only**; the server `close` is the
   **authoritative** result; the client **snaps to the server result** at settle.
3. **Two client balances → one server ledger.** The client has a `SimSettlement` "wallet" (stake/payout)
   **and** a separate `upgrades.coins()` balance (collectible/upgrade coins). → The **stake/payout
   balance becomes the server ledger**; collectible/upgrade coins stay **local & cosmetic** for now
   (no API — matches the roadmap's `addBonus` deferral).

## Scope

**In scope:**
- Client drives `/v1/round/open|action|close`; server ledger is the single source of truth for the
  stake/payout balance.
- `SimSettlement` **retired as the authority**. Local `RoundEngine` stays — **render prediction only**.
- Works against **local dev** (`:8080`) and **deployed Railway**, via `VITE_API_BASE`.
- New web visitors get a **starting play balance** (so the game is instantly playable).

**Out of scope (later pillars):**
- Web/desktop surface (keyboard/gamepad/PWA/landscape/Desktop-HIGH) → **1.5b**.
- Car **ownership gating** by `/v1/inventory` → Pillar 3 (car picker stays local/cosmetic).
- Collectible/upgrade **coins** stay local & cosmetic (no API yet).
- Real Privy auth → Pillar 1.3 (we use `x-dev-user`).
- Autonomous liq/time settlement → Pillar 1.4 (so an abandoned round leaving escrow is an **accepted
  limitation** here).

**Done =** open a round → server debits; rev/flip → server-stamped actions land; cash out or blow up →
server replays and returns the authoritative payout → the HUD balance reflects the server, not a local
sim; reload mid-round recovers cleanly; server-down blocks play with a clear message (never a
local-money fallback).

## Approach — A: faithful action stream

The game plays exactly as today. The local `RoundEngine` runs purely for **live feel/prediction**; the
client mirrors the economically-meaningful events to the server as **server-stamped actions**, and the
server's `close` is the authority. (Approaches B "lock leverage at launch" and C "WebSocket lockstep"
were considered and rejected — B guts the rev-up mechanic, C pulls in 1.4 + a WS layer out of scope.)

## Component decomposition

| Unit | Responsibility | Tested |
|---|---|---|
| **`core/api.ts`** | Typed fetch wrapper: base URL (`VITE_API_BASE`), `x-dev-user` header, typed `me()` / `openRound()` / `roundAction()` / `closeRound()` / `faucet()`, and **error mapping** (each HTTP code → a typed error). Inject `fetch`. | unit |
| **`core/round-sync.ts`** | The live-round session. Owns the current `roundId`, a **sequential action queue** (one POST in flight at a time → server `seq` matches intent order; idempotent on a client `actionId`), and the **~200ms leverage coalescer**. API: `open(params)`, `noteLeverage(lev)`, `noteFlip(dir)`, `close(reason)`. Inject a clock + the api → **pure, testable core**. | unit (the heart) |
| **`core/identity.ts`** | Per-browser dev id (`web-<rand>` persisted in `localStorage`) so each browser = its own server balance. Replaced by Privy in 1.3. | unit |
| **`main.ts` (glue)** | Wire `onLaunch`/`onCashout`/the frame loop to `round-sync`; retire the `SimSettlement` `wallet`; cache the server `balance` (seeded by `me()`, updated by `close()`); **clamp `game.lev` to `int[10,1000]`** before sending; manage connection state + banner. | integration |
| **server: `@fastify/cors`** | Allow the Vercel origin + `localhost:3000` via `CORS_ORIGINS` env. Required for any browser→server call. | server test |
| **server: signup faucet** | New user → credit `START_BALANCE` soft coins **once** (env-gated; replaced by real USDC deposits at F). Makes a fresh visitor playable in prod-`NODE_ENV`. | server test |

All tricky logic (coalescing, queue ordering, error mapping) lives in `api.ts` + `round-sync.ts` as
injectable, unit-tested modules; `main.ts` only glues them to the existing UI.

## Data flow

**Boot**
1. `api.me()` → `{balance, cars}`; seed the cached `balance`, render it. Failure → `disconnected`
   (banner, GO disabled).
2. **Dangling-round recovery:** if a `roundId` is persisted in `localStorage` from a prior session,
   `closeRound(roundId, "expire")` settles it now (frees the single-open-round guard), then refresh
   balance.

**Open** (`onLaunch`, now async)
1. Local UX gate (`stake ≤ cachedBalance`) → else "not enough balance."
2. Show "Launching…", disable GO.
3. `openRound({asset, dir, lev: clampInt(game.lev,10,1000), stake})`.
4. On `200 {roundId, entryRaw, entryTsUs}`: persist `roundId`; `engine.launch({ entryRaw: server
   entryRaw, … })` — **anchor the prediction to the server's entry price**; flip HUD live.
5. On error: 402→"not enough balance", 503→"feed down", 409→recover dangling then retry, network→
   "can't reach server". Re-enable GO.

**Live** (frame loop — feel unchanged)
- Local `RoundEngine` ticks every frame for visuals.
- **Coalescer** (~200ms cadence): if `clampInt(game.lev)` changed since last-sent → `noteLeverage(lev)`
  → enqueue a `lever` action. Clown Car flip → `noteFlip(dir)` → enqueue a `flip`.
- **Sequential queue:** one POST in flight at a time; idempotent on `actionId`. Failed actions retry a
  few times then drop (snap-at-settle covers the gap). Never blocks rendering.

**Close** (cashout **or** local terminal liq/cap/time)
1. Stop the coalescer; **flush** the queue (await pending so the server has the full segment set).
2. `closeRound(roundId, reason)` — `"cashout"` on user cashout, `"expire"` on local liq/cap/time
   (reason is ignored telemetry; the server derives the outcome from its stamped marks).
3. On `200 {outcome, payoutCoins, equity, balance}`: **reconcile** — set `balance = response.balance`,
   clear persisted `roundId`, show the **server's** outcome + banked amount, run the matching FX.
4. Close is **critical** → retry with backoff until it lands (stake is escrowed); persisted `roundId`
   lets a reload retry; if it ultimately can't, the round stays open for 1.4 → "settling shortly."

**Reconciliation (accepted limitation):** the live animation is the *local* prediction; the *server*
close is truth. Because settlement is **marks-only**, a dip the client rendered as a blow-up can return
as a survived payout (or vice-versa). We **always snap to the server result** at settle — house-favorable
in expectation, and exactly the gap 1.4 closes. Consistent with `settleRound`'s own NOTE.

## Error handling & connection states

`connected` / `connecting` (boot or retrying) / `disconnected` (me/open failed) / `settling` (close in
flight). `disconnected` blocks GO with a banner — **never** a local-money fallback. The Hermes price
feed is independent, so the world keeps rendering even when the game server is down; you just can't open
a round.

Error → behavior:
- `open` 402 → "not enough balance"; 503 → "feed down, try again"; 409 `round_already_open` → recover
  dangling then allow retry; network → "can't reach server."
- `action` failure → bounded retries, then drop (best-effort; snap-at-settle covers divergence).
- `close` failure → persistent backoff retry (stake escrowed); persisted `roundId` enables reload-retry;
  ultimate failure → round stays open for 1.4, show "settling shortly."

## Server changes (minimal & safe — no change to settlement/ledger/round logic)

1. **`@fastify/cors`** registered in [`server/src/http/server.ts`](../../../../server/src/http/server.ts)
   with an allowlist from a new `CORS_ORIGINS` env (default `http://localhost:3000`).
2. **Signup faucet:** credit `START_BALANCE` once via the ledger with reason `signup_faucet` and
   `ref=userId`. The ledger's existing **`(reason, ref)` idempotency makes this safe to attempt on
   every `requireUser` / `me()`** — no "was this user just created?" flag needs threading through
   `users.upsertByExternalId`. **Env-gated** (e.g. `SIGNUP_FAUCET=true`) so it is a soft-coin-only
   affordance, removed/replaced by real USDC deposits at F.

The `walletUI.onBuy` "buy USDC" button routes to the faucet in the soft-coin era (or is hidden when the
faucet is disabled); real buying is Pillar F.

## Testing strategy

- **`core/api.ts`** — vitest with injected `fetch`: each method's URL/headers/body; every error code →
  typed error; the `x-dev-user` header is present.
- **`core/round-sync.ts`** — the core suite (fake clock + fake api, fully deterministic): coalescer
  emits ≤1 lever/200ms and only on change; lever values clamped to `int[10,1000]`; queue preserves
  order under concurrent notes; flush-before-close awaits pending; close reconciles balance; retry
  behavior on failure.
- **`core/identity.ts`** — stable, persisted id across calls.
- **server** — a CORS preflight/origin test + a faucet test (new user seeded once, not re-seeded).
- **Preview/manual** — boot shows the server balance; a full round debits then credits the server;
  reload mid-round recovers; kill the server → GO blocked with a banner.

## Decisions resolved (so the plan needn't reopen them)

- **Faithful action stream (A)**, server-stamped, coalesced ~200ms, snap-to-server at settle.
- **Server entry price** anchors the local prediction on open (brief "Launching…" during the round-trip;
  optimistic-launch is a later optimization, not v1).
- **Identity** = per-browser random `web-<id>` in `localStorage` (Privy in 1.3).
- **New-user seeding** = server-side signup faucet (works in prod-`NODE_ENV`, unlike client dev-grant).
- **Abandoned-round escrow** is an **accepted limitation** (1.4's job); mitigated by persisted-`roundId`
  reload recovery.
