# Pillar 1.5 — Client → server cutover (round-money) — design

**Date:** 2026-06-21
**Status:** approved design — **revised after a 4-lens adversarial review** (code-faithfulness,
edge-cases, plan-readiness, internal-consistency; all "ready-with-fixes", folded in below). Ready for
`writing-plans`.
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
  match `/v1/round/open` exactly. `asset` is `"BTC"|"ETH"|"SOL"` (today typed as plain `string` at
  [`main.ts:72`](../../../src/main.ts) — **retype to the shared `Asset` union** so `openRound`'s param
  type-checks without a cast).
- Server: Fastify on **:8080**, **no CORS dependency installed**, dev endpoints env-gated
  (`DEV_ENDPOINTS && NODE_ENV !== "production"`). Vite dev on **:3000**, no proxy.
- Auth is the **`x-dev-user`** header stub (Privy is Pillar 1.3).

### The server contract (already built — used as-is)

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /v1/me` | — | `{userId, balance, cars, openRoundId?}` *(openRoundId is a small addition — see Server changes)* | 401 |
| `POST /v1/round/open` | `{asset, dir:1\|-1, lev:int[10,1000], stake:int[1,50]}` | `{roundId, asset, dir, lev, stake, entryRaw, entryTsUs}` | 402 `insufficient_balance`, 409 `round_already_open`, 503 `feed_halt`, 400 |
| `POST /v1/round/action` | `{roundId:uuid, actionId, kind:"flip"\|"lever", dir?, lev?}` | `{roundId, status, actionCount}` | 404 `round_not_found`, 409 `round_not_open`, 503 `feed_halt`, 400 |
| `POST /v1/round/close` | `{roundId:uuid, reason:"cashout"\|"expire"}` | `{outcome, payoutCoins, pnlCoins, equity, exitRaw, balance}` | 404 `round_not_found`, 503 `feed_halt`, 400 (**no 409**) |
| `GET /v1/round/:id` | — | the round row | 404 |

All behind `requireUser` (the `x-dev-user` header). `close` is idempotent on a settled round (concurrent
double-close → single credit, verified on real Postgres); `action` is idempotent on `(roundId,
actionId)`; the ledger is idempotent on `(reason, ref)`; settlement is **single-writer** and
**marks-only** (terminal conditions checked only at open/action/exit marks — `settle.ts` NOTE).

## The impedance mismatches (what makes this a design, not a wiring task)

1. **Continuous leverage → discrete server actions.** The throttle maps log-scale across ~50 distinct
   `niceLev` values from 10→1000, and a full gas burst (throttle 34→100) takes ~1.3s. Per-frame or
   per-`niceLev`-change streaming is untenable. → **Time-coalesce**: sample the current leverage on a
   ~200ms wall-clock cadence, emit a `lever` action only when it changed vs the last **sent** value.
2. **Per-tick client liquidation → marks-only server settlement.** The client `RoundEngine.tick`
   liquidates the instant equity ≤ LIQ; the server `settleRound` only evaluates terminals at its
   stamped marks (continuous liq is the deferred 1.4 worker's job). → The local engine is **prediction
   only**; the server `close` is **authoritative**; the client **snaps to the server result** at settle.
3. **Two client balances → one server ledger.** The client has a `SimSettlement` "wallet" (stake/payout)
   **and** a separate `upgrades.coins()` counter (collectible/upgrade coins). → The **stake/payout
   balance becomes the server ledger**; collectible/upgrade coins stay **local & cosmetic** (no API yet).

### Prediction/authority parity — the rule that prevents desync

The local `RoundEngine` is prediction-only, so it must compute on **exactly what the server will settle
on**, or the player sees "I survived but the server liquidated me." The review found three silent
divergence sources beyond the intended marks-only gap; this rule closes all three:

- **Leverage:** the local engine **and** every `lever`/`open` action use the **same**
  `clampInt(game.lev, 10, 1000)` value (feed the clamped value into `engine.setLeverage`/`launch` too).
  This is **load-bearing, not cosmetic**: Nitro multiplies `game.lev` by 2 (`NITRO_MULT`) and the Turbo
  Kit raises the client `RMAX` past 1000, so the raw value routinely exceeds the server's hard cap of
  1000 (an un-clamped lever would 400 and silently drop). Below 1000, throttle + Nitro behave exactly as
  shown; **above 1000 the ride is capped at the server's RMAX** for both prediction and settlement.
- **Thresholds:** the local engine settles on the server's **`BASE_CONFIG`** (LIQ 0.2, CAP 25, MAXSEC
  60, RMAX 1000), **not** the client's runtime-mutated `CONFIG`. **Garage upgrades that move
  LIQ/MAXSEC/RMAX (Suspension, Long-Range Tank, Turbo Kit) are cosmetic in 1.5** — they change no round
  economics until per-user config is snapshotted server-side (Pillar 3). *(They're bought with local
  cosmetic coins, which are also not yet server-authoritative — so nothing real is lost.)*
- **Start time:** `engine.launch` uses a `startMs` derived from the server's **`entryTsUs`** (not the
  local `Date.now()` GO-click), so the local MAXSEC countdown and the server's `time` outcome share a
  clock. The opening leverage is **snapshotted once at GO** (the same clamped value POSTed to `open`),
  not a per-frame recompute, so the local open mark matches the server's on both price and leverage.

After this rule, the **only** remaining prediction/authority gap is the intended one: the marks-only
between-marks dip and network latency on action-stamped prices — both house-favorable, both snapped to
the server result at settle.

## Scope

**In scope:**
- Client drives `/v1/round/open|action|close`; server ledger is the single source of truth for the
  stake/payout balance.
- `SimSettlement` **retired as the authority**. Local `RoundEngine` stays — **render prediction only**,
  under the parity rule above.
- Works against **local dev** (`:8080`) and **deployed Railway**, via `VITE_API_BASE`.
- New web visitors get a **starting play balance** (so the game is instantly playable).

**Out of scope (later pillars):**
- Web/desktop surface (keyboard/gamepad/PWA/landscape/Desktop-HIGH) → **1.5b**.
- Car **ownership gating** by `/v1/inventory` → Pillar 3 (car picker stays local/cosmetic).
- Collectible/upgrade **coins** and **garage-upgrade economics** stay local/cosmetic (no API yet; see
  the parity rule).
- Real Privy auth → Pillar 1.3 (we use `x-dev-user`).
- Autonomous liq/time settlement → Pillar 1.4 (so an abandoned round leaving escrow is an **accepted
  limitation** here, bounded by the recovery flow below).

**Done =** open a round → server debits; rev/flip → server-stamped actions land; cash out or blow up →
server replays and returns the authoritative payout → the HUD balance reflects the server, not a local
sim; reload mid-round recovers cleanly; server-down blocks play with a clear message (never a
local-money fallback).

## Approach — A: faithful action stream

The game plays exactly as today. The local `RoundEngine` runs purely for **live feel/prediction** (under
the parity rule); the client mirrors the economically-meaningful events to the server as
**server-stamped actions**, and the server's `close` is the authority. (Approaches B "lock leverage at
launch" and C "WebSocket lockstep" were considered and rejected — B guts the rev-up mechanic, C pulls in
1.4 + a WS layer out of scope.)

## Component decomposition

| Unit | Responsibility | Tested |
|---|---|---|
| **`core/api.ts`** | Typed fetch wrapper: base URL (`VITE_API_BASE`), `x-dev-user` header, typed `me()` / `openRound()` / `roundAction()` / `closeRound()`, and **error mapping** (each HTTP code → a typed error; distinguish `503 feed_halt` from transport errors). Inject `fetch`. | unit |
| **`core/round-sync.ts`** | The live-round session. Owns the current `roundId`, a **sequential action queue** (one POST in flight at a time → server `seq` = intent order), the **~200ms wall-clock leverage coalescer**, an **in-flight-open re-entrancy guard**, and the **close path** (one shared path for cashout / local-terminal / boot-recovery). Inject a **wall clock**, the api, and a **storage port**. **Pure, testable core** (the heart). | unit |
| **`core/identity.ts`** | Per-browser dev id (`web-<rand>`) via an **injectable storage port** (defaults to `localStorage`) so it's testable under the node vitest env. Replaced by Privy in 1.3. | unit |
| **`main.ts` (glue)** | Wire `onLaunch`/`onCashout`/the frame loop to `round-sync`; **retire the `SimSettlement` wallet** (repoint every `wallet.*` call site — see below); cache the server `balance`; feed the **clamped lev + `BASE_CONFIG`** into the local engine (parity); surface connection state via the **existing `hud.setStatus`**. | integration |
| **server: `@fastify/cors`** | Origin allowlist (`CORS_ORIGINS` env) **and `allowedHeaders` including `x-dev-user`** (else preflight blocks every call; `Authorization` joins at 1.3). | server test |
| **server: signup faucet** | In the **`GET /v1/me` handler** (not `requireUser`), credit `START_BALANCE` once via the ledger, reason `signup_faucet`, `ref=userId`; **env-gated** (`SIGNUP_FAUCET`). | server test |
| **server: `openRoundId` on `/v1/me`** | `/v1/me` returns the user's current open round id (a read query) so the client can always recover a round even if local state was lost. | server test |

**`actionId` lifetime (idempotency key — load-bearing):** each enqueued action gets a stable
`actionId` (`crypto.randomUUID()`) assigned **at enqueue time** and **reused verbatim on every retry**
of that same action. The queue retries the identical body. A fresh id per retry would defeat the
server's `(roundId, actionId)` idempotency and double-rebank — explicitly forbidden.

**`wallet.*` call sites to repoint** (mechanical, so a leftover local-money path is caught in review):
boot `setBalance`, `onLaunch` afford-check, `endRound` credit, `walletUI` balance read + `onBuy`. After
this, nothing cross-feeds a local balance. The collectible-coin counter (`upgrades.coins()`) stays a
**separate** local ledger; the top balance chip = server coins, the ◈ counter = local cosmetic coins
(intentionally distinct until the coin economy is server-side).

## Data flow

**Boot**
1. `api.me()` → `{balance, cars, openRoundId?}`; seed the cached `balance`, render it. Failure →
   `disconnected` (banner via `hud.setStatus`, GO disabled).
2. **Dangling-round recovery (server-driven):** if `me()` reports an `openRoundId` (or one is persisted
   locally), run the **shared close path** `closeRound(openRoundId, "expire")` to settle it now and free
   the single-open-round guard, then refresh balance. A `404 round_not_found` here is **benign** → clear
   local state and proceed. Show the server's returned outcome (don't assume win/loss).

**Open** (`onLaunch`, now async)
1. **Re-entrancy guard:** if an open is already in flight (or a round is live), ignore. Gate the GO
   button **and** the Space/Enter triggers.
2. Local UX gate (`stake ≤ cachedBalance`) → else `hud.setStatus("not enough balance")`.
3. Snapshot `lev = clampInt(game.lev, 10, 1000)` **at GO**; show "Launching…", disable GO.
4. `openRound({asset, dir, lev, stake})`.
5. On `200 {roundId, entryRaw, entryTsUs}`: persist `roundId`; `engine.launch({ entryRaw, lev,
   startMs: entryTsUs/1000, … })` — anchor the prediction to the server's **entry price, leverage, and
   time**; flip HUD live.
6. On error: 402→"not enough balance"; 503→"feed down, try again"; network→"can't reach server";
   **409 `round_already_open`** → if we know the open `roundId` (persisted or from `me()`), recover via
   the shared close path then retry; if we **don't** (lost local state, second tab), show "you have a
   round in progress — it'll settle shortly" and defer to 1.4 (the `openRoundId` on `/v1/me` makes this
   rare). Re-enable GO.

**Live** (frame loop — feel unchanged)
- Local `RoundEngine` ticks every frame for visuals, using the **clamped lev + `BASE_CONFIG`** (parity).
- **Coalescer** (wall-clock ~200ms, sampled when the frame loop calls it): if `clampInt(game.lev)`
  changed vs last **sent** → enqueue a `lever`. A backgrounded tab (rAF paused) simply sends the latest
  leverage on the next live frame — no backlog. Clown Car flip → enqueue a `flip`.
- **Single ordered enqueue point:** both the coalescer and the flip handler funnel through the **same**
  queue, so enqueue order == server `seq` order == player-experienced order. One POST in flight;
  idempotent on `actionId`.
- **Action failure:** transport error → bounded retries (N=3, fixed backoff) then drop (snap-at-settle
  covers it). `503 feed_halt` → **keep queued** (don't drop) and resume when the feed recovers.

**Close** (cashout **or** local terminal liq/cap/time)
1. On a local terminal event, enter the **`settling`** state and do **not** fire celebratory/explosion
   FX yet (avoids a fake explosion that a server payout then contradicts).
2. **Force-flush** any pending coalesced lever into the queue, then **drain** the queue (await pending so
   the server has the full segment set).
3. `closeRound(roundId, reason)` — `"cashout"` on user cashout, `"expire"` on local terminal (reason is
   ignored telemetry; the server derives the outcome from its stamped marks).
4. On `200`: **reconcile** — set `balance = response.balance`, clear persisted `roundId`, show the
   **server's** `outcome` + banked amount (`payoutCoins`), and **now** run the FX matching the server
   outcome. *(Client consumes `balance` + `outcome` + `payoutCoins`; `exitRaw`/`pnlCoins` are
   available-but-unused.)*
5. **Close failure:** distinguish causes. Transport error → backoff retry schedule (500ms→1s→2s→4s, cap
   8s) while the tab lives; persisted `roundId` lets a reload retry via the shared close path. **`503
   feed_halt`** → the server *cannot* settle while the feed is halted, so **cap the retry budget and
   fall through to the `settling shortly` / 1.4 state** rather than looping forever.

**Reconciliation:** the live animation is the *local* prediction (now parity-aligned); the *server*
close is truth. The only intended gap is the marks-only between-marks dip + action-stamp latency — both
house-favorable. We **always snap to the server result** at settle. Boot-recovery and an in-session
close-retry share **one** close path (never double-issued); the per-user advisory lock + `status='open'`
guard make whichever lands first authoritative, and the UI shows the server's returned outcome
regardless of what was predicted pre-reload.

## Error handling & connection states

`connected` / `connecting` (boot or retrying) / `disconnected` (me/open failed) / `settling` (close in
flight). `disconnected` blocks GO with a banner (`hud.setStatus`) — **never** a local-money fallback.
The Hermes price feed is independent, so the world keeps rendering even when the game server is down;
you just can't open a round.

Key rules (from the review):
- **`503 feed_halt` ≠ transport error.** Action-503 → keep the note queued, resume on feed recovery.
  Close-503 → bounded retries then `settling shortly`/1.4 (the server literally cannot settle).
- **Lost-roundId 409** → recover via the `openRoundId` on `/v1/me`; if still unknown, defer to 1.4 with
  a clear message (no silent no-op loop).
- **Benign 404** on a recovery close → clear local state, proceed.

## Server changes (three small additions — none touch settlement/ledger/round-close logic)

1. **`@fastify/cors`** in [`server/src/http/server.ts`](../../../../server/src/http/server.ts): origin
   allowlist from `CORS_ORIGINS` (default `http://localhost:3000`) **plus `allowedHeaders: ["x-dev-user",
   "content-type"]`**. *(A Vite dev proxy would fix only localhost; prod is cross-origin Vercel→Railway,
   so server-side CORS is the single mechanism for both.)*
2. **Signup faucet** in the **`GET /v1/me` handler**: credit `START_BALANCE` with reason `signup_faucet`,
   `ref=userId`. The ledger's `(reason, ref)` unique index (`onConflictDoNothing`) makes this credit
   **once and only once**, safe to attempt on every `me()` — so no "was this user just created?" flag is
   needed and `requireUser` (the 1.3 auth seam) stays untouched. **Env-gated** (`SIGNUP_FAUCET=true`);
   fires regardless of `NODE_ENV` (unlike the dev-only `dev/grant-coins`), so it works in deployed
   soft-coin Alpha. Removed/replaced by real USDC deposits at F.
3. **`openRoundId` on `/v1/me`**: a read query returning the user's current `status='open'` round id (or
   null), so the client can always recover a dangling round without relying on `localStorage`.

The `walletUI.onBuy` "buy USDC" button is **hidden/disabled in the soft-coin era** (real buying is
Pillar F) — there is no repeatable top-up endpoint, and routing it at the one-shot `signup_faucet` ref
would no-op. No `api.faucet()` method is added.

## Testing strategy

- **`core/api.ts`** — injected `fetch`: each method's URL/headers/body; the `x-dev-user` header is
  present; **every error code → its typed error**, with `503 feed_halt` distinguished from transport.
- **`core/round-sync.ts`** (fake clock + fake api + fake storage, fully deterministic):
  - coalescer emits ≤1 lever/200ms, dedup on last-**sent**; a **blip-revert** (200→250→200 within a
    window) emits **no** POST; a 1000ms gap emits exactly one lever with the final value.
  - **clamp**: a `noteLeverage(1500)`/`(2000)` emits `1000`.
  - **ordering**: interleaved `noteFlip`/`noteLeverage` in one window POST in enqueue order.
  - **idempotency**: a failed-then-retried action posts the **same** `actionId` (one server row).
  - **re-entrancy**: two `open()` calls in flight → exactly one POST.
  - **close**: force-flush of a pending lever before drain; reconcile balance to the server; close-503 →
    `settling`/1.4 (not infinite retry); boot-recovery + in-session retry share one path.
- **`core/identity.ts`** — stable, persisted id across calls (via the injected storage port).
- **server** — CORS preflight asserts the origin allowlist **and** `x-dev-user` in allowed-headers; a
  faucet test asserting (a) `SIGNUP_FAUCET` off → no credit, (b) on → first-seen user gets exactly
  `START_BALANCE` once and a second `me()` does not re-credit, (c) fires regardless of `NODE_ENV`; an
  `openRoundId` test (open round id returned; null when none).
- **Preview/manual** — boot shows the server balance; a full round debits then credits the server; a
  Nitro round settles at the server's capped leverage with no payout surprise; reload mid-round recovers
  via `openRoundId`; kill the server → GO blocked with a banner.

## Decisions resolved (so the plan needn't reopen them)

- **Faithful action stream (A)**, server-stamped, coalesced ~200ms on a **wall clock**, snap-to-server
  at settle.
- **Prediction/authority parity**: the local engine uses the server's `BASE_CONFIG` + clamped lev +
  `entryTsUs`-derived `startMs`. **Garage upgrades (Nitro top-end, Turbo/Suspension/Tank) are cosmetic
  in 1.5**; their economics return when per-user config is server-snapshotted (Pillar 3).
- **`actionId`** = `crypto.randomUUID()` at enqueue, reused across retries.
- **Identity** = per-browser `web-<rand>` via an injectable storage port (Privy in 1.3).
- **New-user seeding** = server-side signup faucet in `/v1/me` (env-gated, idempotent, prod-safe). No
  client faucet; `onBuy` hidden in the soft-coin era.
- **Recovery** = server `openRoundId` is the source of truth (localStorage `roundId` is a fast path); a
  truly lost open round defers to **1.4**.
- **FX after settle**: local terminal → `settling` (no FX) → server result → matching FX.
- **Connection state** surfaced via the existing `hud.setStatus`; no new UI unit.
- **Retry budgets**: action = 3 + fixed backoff then drop; close = 500ms→1s→2s→4s (cap 8s) while the tab
  lives, with the persisted-`roundId`/`openRoundId` reload path as the durable backstop.
- **Abandoned-round escrow** remains an accepted limitation (1.4's job), now bounded by `openRoundId`
  recovery.
