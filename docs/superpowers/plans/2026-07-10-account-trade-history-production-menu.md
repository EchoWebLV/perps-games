# Account Trade History and Production Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store signed-in on-chain settlements as account-wide display history, add a History menu and panel, and limit the Garage and Upgrades hamburger rows to the local browser development server.

**Architecture:** A pure client environment policy controls only the two development menu rows. Confirmed on-chain settlements enter a wallet-scoped local outbox and are posted idempotently to a dedicated authenticated server service and PostgreSQL table. A separate History UI reads cursor-paginated server records; none of this data is imported by money or progression services.

**Tech Stack:** TypeScript, Vite, Vitest, jsdom, Fastify, Zod, Drizzle ORM, PostgreSQL/PGlite, Capacitor runtime detection.

## Global Constraints

- History is account-wide for signed-in trades and excludes every guest practice run.
- The on-chain Raider round remains the source of truth for balances, payouts, and settlement.
- Trade history is display-only and must never drive money, rewards, progression, or entitlements.
- Garage and Upgrades hamburger rows require Vite development mode, a loopback hostname, and a non-native runtime.
- A Capacitor WebView using `localhost` must still hide Garage and Upgrades.
- History remains present in local development, production web, and the native app.
- No pre-feature trade backfill is included.
- Preserve the existing uncommitted `.claude/launch.json` change.
- Do not provide implementation-time estimates unless the user explicitly asks.

---

## File Structure

### New files

- `redline3d/src/core/menu-visibility.ts`: pure local-browser menu policy.
- `redline3d/src/core/menu-visibility.test.ts`: policy matrix, including Capacitor-on-localhost.
- `redline3d/src/core/trade-history-recorder.ts`: active draft plus durable wallet-scoped outbox.
- `redline3d/src/core/trade-history-recorder.test.ts`: outbox, retry, and duplicate-settlement tests.
- `redline3d/src/ui/trade-history.ts`: standalone History overlay and pagination UI.
- `redline3d/src/ui/trade-history.test.ts`: signed-out, empty, populated, error, and pagination states.
- `server/src/services/trade-history.ts`: idempotent insert and stable cursor pagination.
- `server/src/services/trade-history.test.ts`: persistence, identity, ordering, and isolation tests.
- `server/src/test/trade-history-routes.test.ts`: authenticated endpoint tests.
- `server/drizzle/0015_account_trade_history.sql`: generated migration.
- `server/drizzle/meta/0015_snapshot.json`: generated schema snapshot.
- `server/drizzle/meta/_journal.json`: generated migration journal entry.

### Modified files

- `redline3d/src/ui/carpicker.ts`: conditional Garage/Upgrades rows and History callback.
- `redline3d/src/ui/carpicker.test.ts`: menu visibility and History click tests.
- `redline3d/src/core/api.ts`: trade record/list types and methods.
- `redline3d/src/core/api.test.ts`: trade endpoint request tests.
- `redline3d/src/chain/game-session.ts`: include confirmed exit price in the settlement callback type.
- `redline3d/src/chain/game-session.test.ts`: settlement callback payload coverage.
- `redline3d/src/main.ts`: runtime policy, recorder lifecycle, History panel, and launch guard.
- `server/src/db/schema.ts`: `trade_history` table.
- `server/src/http/routes.ts`: authenticated trade endpoints and validation.
- `server/src/index.ts`: construct and inject the service.
- `server/src/test/harness.ts`: construct and expose the service in tests.
- `docs/superpowers/specs/2026-07-10-account-trade-history-production-menu-design.md`: no behavior changes; reference only.

---

### Task 1: Local-only Garage and Upgrades menu policy

**Files:**
- Create: `redline3d/src/core/menu-visibility.ts`
- Create: `redline3d/src/core/menu-visibility.test.ts`
- Modify: `redline3d/src/ui/carpicker.ts`
- Modify: `redline3d/src/ui/carpicker.test.ts`

**Interfaces:**
- Produces: `showLocalEconomyMenu(input: { dev: boolean; hostname: string; native: boolean }): boolean`
- Produces: `MenuFeatures { showGarageAndUpgrades?: boolean; onHistory?: () => void }`
- Consumed later by: `main.ts` and the History UI integration.

- [ ] **Step 1: Write the failing environment-policy test**

```ts
import { describe, expect, it } from "vitest";
import { showLocalEconomyMenu } from "./menu-visibility";

describe("showLocalEconomyMenu", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("shows on local browser dev host %s", (hostname) => {
    expect(showLocalEconomyMenu({ dev: true, hostname, native: false })).toBe(true);
  });

  it("hides in a Capacitor WebView even when its hostname is localhost", () => {
    expect(showLocalEconomyMenu({ dev: true, hostname: "localhost", native: true })).toBe(false);
  });

  it.each([
    { dev: false, hostname: "localhost", native: false },
    { dev: true, hostname: "app.example.com", native: false },
    { dev: false, hostname: "app.example.com", native: true },
  ])("hides outside local browser development: %o", (input) => {
    expect(showLocalEconomyMenu(input)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `npm test -- src/core/menu-visibility.test.ts`

Expected: FAIL because `./menu-visibility` does not exist.

- [ ] **Step 3: Implement the pure policy**

```ts
export interface MenuRuntime {
  dev: boolean;
  hostname: string;
  native: boolean;
}

export function showLocalEconomyMenu(input: MenuRuntime): boolean {
  const hostname = input.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return input.dev && !input.native && loopback;
}
```

- [ ] **Step 4: Run the policy test and verify GREEN**

Run: `npm test -- src/core/menu-visibility.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing car-picker menu tests**

Add to `carpicker.test.ts`:

```ts
describe("hamburger product menu", () => {
  const oneCar: CarOption[] = [{ name: "Solana Paper", url: "/models/trabant.glb" }];

  it("always exposes History but can omit Garage and Upgrades", () => {
    const parent = document.createElement("div");
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, undefined, undefined, undefined, {
      showGarageAndUpgrades: false,
      onHistory: () => {},
    });
    expect(parent.querySelector('[data-act="history"]')).not.toBeNull();
    expect(parent.querySelector('[data-go="garage"]')).toBeNull();
    expect(parent.querySelector('[data-act="upgrades"]')).toBeNull();
  });

  it("calls the History callback from the menu row", () => {
    const parent = document.createElement("div");
    let opens = 0;
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, undefined, undefined, undefined, {
      showGarageAndUpgrades: false,
      onHistory: () => { opens++; },
    });
    (parent.querySelector('[data-act="history"]') as HTMLButtonElement).click();
    expect(opens).toBe(1);
  });
});
```

- [ ] **Step 6: Run the car-picker test and verify RED**

Run: `npm test -- src/ui/carpicker.test.ts`

Expected: FAIL because `createCarPicker` does not accept menu features and no History row exists.

- [ ] **Step 7: Add the menu feature interface and conditional rows**

Add the final optional parameter without changing the existing positional parameters:

```ts
export interface MenuFeatures {
  showGarageAndUpgrades?: boolean;
  onHistory?: () => void;
}

export function createCarPicker(
  parent: HTMLElement,
  cars: CarOption[],
  onPick: (c: CarOption) => void,
  onUpgrades?: () => void,
  toggles: MenuToggle[] = [],
  onLogout?: () => void,
  onClose?: (reason?: "dismiss" | "chain") => void,
  accountInfo?: () => { label: string; sub: string },
  worlds?: WorldPicker,
  menuFeatures: MenuFeatures = {},
): Garage {
```

Build the rows as strings before `menuPanel.innerHTML`:

```ts
const localRows = menuFeatures.showGarageAndUpgrades === false ? "" : `
  <button class="gmenu-item" data-go="garage"><span class="gmenu-ic">${icon("car", 20)}</span><span class="gmenu-tx"><b>Garage</b><small>your card collection</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
  <button class="gmenu-item" data-act="upgrades"><span class="gmenu-ic">${icon("level", 20)}</span><span class="gmenu-tx"><b>Upgrades</b><small>tune your car</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>`;

const historyRow = `
  <button class="gmenu-item" data-act="history"><span class="gmenu-ic">${icon("clock", 20)}</span><span class="gmenu-tx"><b>History</b><small>your settled trades</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>`;
```

Insert `${localRows}${historyRow}` before How to play. In the existing click dispatcher, handle History through the chained-overlay close path:

```ts
if (act === "history") {
  close("chain");
  menuFeatures.onHistory?.();
  return;
}
```

- [ ] **Step 8: Run focused tests and commit**

Run: `npm test -- src/core/menu-visibility.test.ts src/ui/carpicker.test.ts`

Expected: PASS.

```bash
git add redline3d/src/core/menu-visibility.ts redline3d/src/core/menu-visibility.test.ts redline3d/src/ui/carpicker.ts redline3d/src/ui/carpicker.test.ts
git commit -m "feat: gate local economy menu rows"
```

---

### Task 2: Dedicated trade-history persistence service

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/src/services/trade-history.ts`
- Create: `server/src/services/trade-history.test.ts`
- Create: generated `server/drizzle/0015_account_trade_history.sql`
- Modify: generated `server/drizzle/meta/_journal.json`
- Create: generated `server/drizzle/meta/0015_snapshot.json`

**Interfaces:**
- Produces: `TradeRecordInput`, `TradeHistoryItem`, `TradeHistoryPage`, and `makeTradeHistory({ db, users, now? })`.
- Consumed later by: Fastify routes and the test harness.

- [ ] **Step 1: Write failing service tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestCtx } from "../test/harness.js";
import { makeTradeHistory } from "./trade-history.js";

const input = (id: string) => ({
  id,
  asset: "SOL" as const,
  dir: 1 as const,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150.25,
  exitPrice: 151.5,
  openedAt: new Date("2026-07-10T10:00:00.000Z"),
  outcome: "cashout" as const,
  payoutBase: 11_000_000,
});

describe("trade history service", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("derives the bound wallet and inserts a UUID idempotently", async () => {
    ctx = await makeTestDb();
    const user = await ctx.users.upsertByExternalId("wallet:alice");
    await ctx.users.setWalletPublicKey(user.id, "AliceWallet");
    const history = makeTradeHistory({ db: ctx.db, users: ctx.users, now: () => new Date("2026-07-10T10:01:00.000Z") });

    const first = await history.record(user.id, input("11111111-1111-4111-8111-111111111111"));
    const replay = await history.record(user.id, input("11111111-1111-4111-8111-111111111111"));

    expect(replay).toEqual(first);
    expect(first.walletPublicKey).toBe("AliceWallet");
    expect(first.pnlBase).toBe(1_000_000);
    expect((await history.list(user.id, undefined, 25)).items).toHaveLength(1);
  });

  it("paginates newest first without exposing another user", async () => {
    ctx = await makeTestDb();
    const alice = await ctx.users.upsertByExternalId("wallet:alice-page");
    const bob = await ctx.users.upsertByExternalId("wallet:bob-page");
    await ctx.users.setWalletPublicKey(alice.id, "AlicePageWallet");
    await ctx.users.setWalletPublicKey(bob.id, "BobPageWallet");
    let tick = 0;
    const history = makeTradeHistory({ db: ctx.db, users: ctx.users, now: () => new Date(1_700_000_000_000 + tick++ * 1000) });
    await history.record(alice.id, input("11111111-1111-4111-8111-111111111111"));
    await history.record(alice.id, input("22222222-2222-4222-8222-222222222222"));
    await history.record(alice.id, input("33333333-3333-4333-8333-333333333333"));
    await history.record(bob.id, input("44444444-4444-4444-8444-444444444444"));

    const page1 = await history.list(alice.id, undefined, 2);
    const page2 = await history.list(alice.id, page1.nextCursor ?? undefined, 2);
    expect(page1.items.map((row) => row.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(page2.items.map((row) => row.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(page2.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `npm test -- src/services/trade-history.test.ts`

Expected: FAIL because `trade-history.ts` and the table do not exist.

- [ ] **Step 3: Add the schema table**

```ts
export const tradeHistory = pgTable(
  "trade_history",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    walletPublicKey: text("wallet_public_key").notNull(),
    asset: text("asset").notNull(),
    dir: integer("dir").notNull(),
    lev: integer("lev").notNull(),
    stakeBase: bigint("stake_base", { mode: "number" }).notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    exitPrice: doublePrecision("exit_price").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    payoutBase: bigint("payout_base", { mode: "number" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSettledIdx: index("trade_history_user_settled_idx").on(t.userId, t.settledAt, t.id),
  }),
);

export type TradeHistoryRow = typeof tradeHistory.$inferSelect;
```

- [ ] **Step 4: Implement the focused service**

Use Drizzle `and`, `desc`, `eq`, `lt`, and `or`. Expose these exact types:

```ts
export type TradeAsset = "BTC" | "ETH" | "SOL";
export type TradeOutcome = "cashout" | "cap" | "liq" | "time";

export interface TradeRecordInput {
  id: string;
  asset: TradeAsset;
  dir: 1 | -1;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: Date;
  outcome: TradeOutcome;
  payoutBase: number;
}

export interface TradeHistoryItem {
  id: string;
  walletPublicKey: string;
  asset: TradeAsset;
  dir: 1 | -1;
  lev: number;
  stakeBase: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  outcome: TradeOutcome;
  payoutBase: number;
  pnlBase: number;
  settledAt: string;
}

export interface TradeHistoryPage {
  items: TradeHistoryItem[];
  nextCursor: string | null;
}
```

Cursor and row mapping:

```ts
type Cursor = { settledAt: string; id: string };
const encodeCursor = (row: { settledAt: Date; id: string }) =>
  Buffer.from(JSON.stringify({ settledAt: row.settledAt.toISOString(), id: row.id })).toString("base64url");

function decodeCursor(value: string): Cursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed.id !== "string" || Number.isNaN(Date.parse(parsed.settledAt))) throw new Error("bad_cursor");
  return parsed;
}

const itemOf = (row: TradeHistoryRow): TradeHistoryItem => ({
  id: row.id,
  walletPublicKey: row.walletPublicKey,
  asset: row.asset as TradeAsset,
  dir: row.dir as 1 | -1,
  lev: row.lev,
  stakeBase: row.stakeBase,
  entryPrice: row.entryPrice,
  exitPrice: row.exitPrice,
  openedAt: row.openedAt.toISOString(),
  outcome: row.outcome as TradeOutcome,
  payoutBase: row.payoutBase,
  pnlBase: row.payoutBase - row.stakeBase,
  settledAt: row.settledAt.toISOString(),
});
```

Factory behavior:

```ts
export function makeTradeHistory(opts: { db: any; users: Users; now?: () => Date }) {
  const now = opts.now ?? (() => new Date());
  return {
    async record(userId: string, input: TradeRecordInput): Promise<TradeHistoryItem> {
      const user = await opts.users.get(userId);
      if (!user?.walletPublicKey) throw new Error("wallet_required");
      await opts.db.insert(tradeHistory).values({
        ...input,
        userId,
        walletPublicKey: user.walletPublicKey,
        settledAt: now(),
      }).onConflictDoNothing({ target: tradeHistory.id });
      const rows = await opts.db.select().from(tradeHistory).where(eq(tradeHistory.id, input.id)).limit(1);
      if (!rows[0] || rows[0].userId !== userId) throw new Error("trade_id_conflict");
      return itemOf(rows[0]);
    },

    async list(userId: string, cursor: string | undefined, limit: number): Promise<TradeHistoryPage> {
      const c = cursor ? decodeCursor(cursor) : null;
      const before = c ? or(
        lt(tradeHistory.settledAt, new Date(c.settledAt)),
        and(eq(tradeHistory.settledAt, new Date(c.settledAt)), lt(tradeHistory.id, c.id)),
      ) : undefined;
      const where = before ? and(eq(tradeHistory.userId, userId), before) : eq(tradeHistory.userId, userId);
      const rows = await opts.db.select().from(tradeHistory).where(where)
        .orderBy(desc(tradeHistory.settledAt), desc(tradeHistory.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: page.map(itemOf),
        nextCursor: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]) : null,
      };
    },
  };
}

export type TradeHistory = ReturnType<typeof makeTradeHistory>;
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `npm run db:generate -- --name account_trade_history`

Expected: `0015_account_trade_history.sql`, `0015_snapshot.json`, and one journal entry creating only `trade_history` and its index.

- [ ] **Step 6: Run the service test and migration runtime test**

Run: `npm test -- src/services/trade-history.test.ts src/db/runtime.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/src/services/trade-history.ts server/src/services/trade-history.test.ts server/drizzle
git commit -m "feat(server): persist account trade history"
```

---

### Task 3: Authenticated trade-history HTTP API

**Files:**
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/test/harness.ts`
- Create: `server/src/test/trade-history-routes.test.ts`

**Interfaces:**
- Consumes: `TradeHistory.record` and `TradeHistory.list` from Task 2.
- Produces: `POST /v1/trades` and `GET /v1/trades`.

- [ ] **Step 1: Write failing route tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { bindDevWallet, makeTestDb, type TestCtx } from "./harness.js";

const headers = { "x-dev-user": "trade-alice", "content-type": "application/json" };
const body = {
  id: "11111111-1111-4111-8111-111111111111",
  asset: "SOL",
  dir: 1,
  lev: 250,
  stakeBase: 10_000_000,
  entryPrice: 150.25,
  exitPrice: 151.5,
  openedAt: "2026-07-10T10:00:00.000Z",
  outcome: "cashout",
  payoutBase: 11_000_000,
};

describe("trade history routes", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("records idempotently and lists only the authenticated account", async () => {
    ctx = await makeTestDb();
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");
    const first = await ctx.server.inject({ method: "POST", url: "/v1/trades", headers, payload: body });
    const replay = await ctx.server.inject({ method: "POST", url: "/v1/trades", headers, payload: body });
    const list = await ctx.server.inject({ method: "GET", url: "/v1/trades?limit=25", headers });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ walletPublicKey: "AliceWallet", pnlBase: 1_000_000 });
  });

  it("requires a wallet-bound account and validates numeric fields", async () => {
    ctx = await makeTestDb();
    const unbound = await ctx.server.inject({ method: "POST", url: "/v1/trades", headers, payload: body });
    expect(unbound.statusCode).toBe(403);
    await bindDevWallet(ctx, "trade-alice", "AliceWallet");
    const bad = await ctx.server.inject({ method: "POST", url: "/v1/trades", headers, payload: { ...body, payoutBase: -1 } });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm test -- src/test/trade-history-routes.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Wire the service into dependencies**

Add `tradeHistory: TradeHistory` to `RouteDeps` and `TestCtx`. Construct it with `makeTradeHistory({ db, users })` in both `index.ts` and `makeTestDb`, then pass it to `buildServer`.

The exact dependency additions are:

```ts
import { makeTradeHistory, type TradeHistory } from "./services/trade-history.js";
// after users is created
const tradeHistory = makeTradeHistory({ db, users });
// buildServer deps
tradeHistory,
```

- [ ] **Step 4: Add Zod validation and authenticated routes**

```ts
const TradeBody = z.object({
  id: z.string().uuid(),
  asset: z.enum(["BTC", "ETH", "SOL"]),
  dir: z.union([z.literal(1), z.literal(-1)]),
  lev: z.number().int().min(1).max(3000),
  stakeBase: z.number().int().positive().safe(),
  entryPrice: z.number().positive().finite(),
  exitPrice: z.number().positive().finite(),
  openedAt: z.string().datetime(),
  outcome: z.enum(["cashout", "cap", "liq", "time"]),
  payoutBase: z.number().int().min(0).safe(),
});

const TradeQuery = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
```

Register before the legacy round endpoints:

```ts
server.post("/v1/trades", { preHandler: requireWalletBoundUser }, async (req, reply) => {
  const parsed = TradeBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
  try {
    return await deps.tradeHistory.record(req.userId!, {
      ...parsed.data,
      openedAt: new Date(parsed.data.openedAt),
    });
  } catch (error) {
    if ((error as Error).message === "trade_id_conflict") return reply.code(409).send({ error: "trade_id_conflict" });
    throw error;
  }
});

server.get("/v1/trades", { preHandler: requireWalletBoundUser }, async (req, reply) => {
  const parsed = TradeQuery.safeParse(req.query);
  if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
  try {
    return await deps.tradeHistory.list(req.userId!, parsed.data.cursor, parsed.data.limit);
  } catch (error) {
    if ((error as Error).message === "bad_cursor") return reply.code(400).send({ error: "bad_cursor" });
    throw error;
  }
});
```

- [ ] **Step 5: Run route and server build verification**

Run: `npm test -- src/test/trade-history-routes.test.ts src/services/trade-history.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/routes.ts server/src/index.ts server/src/test/harness.ts server/src/test/trade-history-routes.test.ts
git commit -m "feat(server): expose account trade history"
```

---

### Task 4: Client API and durable settlement outbox

**Files:**
- Modify: `redline3d/src/core/api.ts`
- Modify: `redline3d/src/core/api.test.ts`
- Create: `redline3d/src/core/trade-history-recorder.ts`
- Create: `redline3d/src/core/trade-history-recorder.test.ts`

**Interfaces:**
- Produces: client `TradeRecordInput`, `TradeHistoryItem`, and `TradeHistoryPage`.
- Produces: `Api.recordTrade(input)` and `Api.listTrades(cursor?)`.
- Produces: `createTradeHistoryRecorder({ api, wallet, store?, newId? })` with `begin`, `complete`, and `flush`.
- Consumed later by: `main.ts` and `ui/trade-history.ts`.

- [ ] **Step 1: Write failing API tests**

```ts
it("records and cursor-lists account trade history", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const api = createApi({
    baseUrl: "http://x",
    userId: "u",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return res(200, String(url).includes("cursor=")
        ? { items: [], nextCursor: null }
        : { id: "11111111-1111-4111-8111-111111111111" });
    },
  });
  const record = {
    id: "11111111-1111-4111-8111-111111111111", asset: "SOL" as const, dir: 1 as const, lev: 250,
    stakeBase: 10_000_000, entryPrice: 150, exitPrice: 151,
    openedAt: "2026-07-10T10:00:00.000Z", outcome: "cashout" as const, payoutBase: 11_000_000,
  };
  await api.recordTrade(record);
  await api.listTrades("next token");
  expect(calls).toEqual([
    { url: "http://x/v1/trades", body: record },
    { url: "http://x/v1/trades?limit=25&cursor=next%20token", body: undefined },
  ]);
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `npm test -- src/core/api.test.ts`

Expected: FAIL because the two API methods do not exist.

- [ ] **Step 3: Add API types and methods**

```ts
export type TradeOutcome = "cashout" | "cap" | "liq" | "time";
export interface TradeRecordInput {
  id: string; asset: Asset; dir: Dir; lev: number; stakeBase: number;
  entryPrice: number; exitPrice: number; openedAt: string;
  outcome: TradeOutcome; payoutBase: number;
}
export interface TradeHistoryItem extends TradeRecordInput {
  walletPublicKey: string; pnlBase: number; settledAt: string;
}
export interface TradeHistoryPage { items: TradeHistoryItem[]; nextCursor: string | null; }
```

Add to `Api` and the returned object:

```ts
recordTrade(input: TradeRecordInput): Promise<TradeHistoryItem>;
listTrades(cursor?: string): Promise<TradeHistoryPage>;

recordTrade: (input) => call<TradeHistoryItem>("POST", "/v1/trades", input),
listTrades: (cursor) => call<TradeHistoryPage>(
  "GET",
  `/v1/trades?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
),
```

- [ ] **Step 4: Run API tests and verify GREEN**

Run: `npm test -- src/core/api.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing recorder tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createTradeHistoryRecorder } from "./trade-history-recorder";

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const draft = {
  asset: "SOL" as const, dir: 1 as const, lev: 250, stakeBase: 10_000_000,
  entryPrice: 150, openedAt: "2026-07-10T10:00:00.000Z",
};

describe("trade history recorder", () => {
  it("keeps a failed upload and removes it after a retry", async () => {
    const recordTrade = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    expect(recorder.complete({ outcome: "cashout", payoutBase: 11_000_000, exitPrice: 151 })).not.toBeNull();
    await recorder.flush();
    await recorder.flush();
    expect(recordTrade).toHaveBeenCalledTimes(2);
    expect(recorder.pending()).toBe(0);
  });

  it("completes one record at most once", () => {
    const recorder = createTradeHistoryRecorder({
      api: { recordTrade: vi.fn() } as any,
      wallet: () => "AliceWallet",
      store: memoryStore(),
      newId: () => "11111111-1111-4111-8111-111111111111",
    });
    recorder.begin(draft);
    expect(recorder.complete({ outcome: "liq", payoutBase: 0, exitPrice: 149 })).not.toBeNull();
    expect(recorder.complete({ outcome: "liq", payoutBase: 0, exitPrice: 149 })).toBeNull();
    expect(recorder.pending()).toBe(1);
  });
});
```

- [ ] **Step 6: Run recorder tests and verify RED**

Run: `npm test -- src/core/trade-history-recorder.test.ts`

Expected: FAIL because the recorder does not exist.

- [ ] **Step 7: Implement the recorder**

Use these exact public shapes:

```ts
export type ActiveTradeDraft = Omit<TradeRecordInput, "id" | "exitPrice" | "outcome" | "payoutBase">;
export type TradeCompletion = Pick<TradeRecordInput, "exitPrice" | "outcome" | "payoutBase">;
export interface TradeHistoryRecorder {
  begin(draft: ActiveTradeDraft): void;
  complete(result: TradeCompletion): TradeRecordInput | null;
  flush(): Promise<void>;
  pending(): number;
}
```

Implementation rules:

```ts
const PREFIX = "redline.trade-history.outbox.v1:";

export function createTradeHistoryRecorder(deps: {
  api: Pick<Api, "recordTrade">;
  wallet: () => string;
  store?: Storage;
  newId?: () => string;
}): TradeHistoryRecorder {
  const store = deps.store ?? localStorage;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let active: (ActiveTradeDraft & { id: string; outboxKey: string }) | null = null;
  let flushing: Promise<void> | null = null;
  const key = () => PREFIX + deps.wallet();
  const readAt = (outboxKey: string): TradeRecordInput[] => {
    try {
      const value = JSON.parse(store.getItem(outboxKey) ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  };
  const writeAt = (outboxKey: string, items: TradeRecordInput[]) => items.length
    ? store.setItem(outboxKey, JSON.stringify(items))
    : store.removeItem(outboxKey);

  return {
    begin(draft) {
      if (deps.wallet()) active = { ...draft, id: newId(), outboxKey: key() };
    },
    complete(result) {
      if (!active) return null;
      const { outboxKey, ...draft } = active;
      const record = { ...draft, ...result };
      active = null;
      const items = readAt(outboxKey);
      if (!items.some((item) => item.id === record.id)) writeAt(outboxKey, [...items, record]);
      return record;
    },
    flush() {
      if (flushing) return flushing;
      const outboxKey = key();
      flushing = (async () => {
        const items = readAt(outboxKey);
        for (const item of items) {
          try {
            await deps.api.recordTrade(item);
            writeAt(outboxKey, readAt(outboxKey).filter((pending) => pending.id !== item.id));
          } catch { break; }
        }
      })().finally(() => { flushing = null; });
      return flushing;
    },
    pending: () => readAt(key()).length,
  };
}
```

- [ ] **Step 8: Run focused tests and commit**

Run: `npm test -- src/core/api.test.ts src/core/trade-history-recorder.test.ts`

Expected: PASS.

```bash
git add redline3d/src/core/api.ts redline3d/src/core/api.test.ts redline3d/src/core/trade-history-recorder.ts redline3d/src/core/trade-history-recorder.test.ts
git commit -m "feat(client): queue account trade history"
```

---

### Task 5: History overlay

**Files:**
- Create: `redline3d/src/ui/trade-history.ts`
- Create: `redline3d/src/ui/trade-history.test.ts`

**Interfaces:**
- Consumes: `TradeHistoryPage` and `TradeHistoryItem` from `core/api.ts`.
- Produces: `TradeHistoryPanel { open(): Promise<void>; close(): void; isOpen(): boolean }`.
- Consumed later by: `main.ts` and the GO keyboard guard.

- [ ] **Step 1: Write failing UI tests**

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTradeHistory } from "./trade-history";

const item = {
  id: "11111111-1111-4111-8111-111111111111", walletPublicKey: "AliceWallet",
  asset: "SOL" as const, dir: 1 as const, lev: 250, stakeBase: 10_000_000,
  entryPrice: 150, exitPrice: 151, openedAt: "2026-07-10T10:00:00.000Z",
  outcome: "cashout" as const, payoutBase: 11_000_000, pnlBase: 1_000_000,
  settledAt: "2026-07-10T10:01:00.000Z",
};

describe("trade history panel", () => {
  it("shows sign-in-required without loading guest history", async () => {
    const load = vi.fn();
    const panel = createTradeHistory(document.body, { signedIn: () => false, flush: vi.fn(), load });
    await panel.open();
    expect(document.body.textContent).toContain("Sign in to view your trade history");
    expect(load).not.toHaveBeenCalled();
  });

  it("renders trades and loads the next cursor", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ items: [item], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [{ ...item, id: "22222222-2222-4222-8222-222222222222" }], nextCursor: null });
    const panel = createTradeHistory(document.body, { signedIn: () => true, flush: vi.fn(), load });
    await panel.open();
    expect(document.body.textContent).toContain("SOL");
    expect(document.body.textContent).toContain("LONG");
    expect(document.body.textContent).toContain("+0.001 SOL");
    (document.querySelector('[data-history="more"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenLastCalledWith("next");
    expect(document.querySelectorAll("[data-trade-id]")).toHaveLength(2);
  });

  it("shows a retry action after a load failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ items: [], nextCursor: null });
    const panel = createTradeHistory(document.body, { signedIn: () => true, flush: vi.fn(), load });
    await panel.open();
    expect(document.body.textContent).toContain("Could not load history");
    (document.querySelector('[data-history="retry"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toContain("No settled trades yet");
  });
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test -- src/ui/trade-history.test.ts`

Expected: FAIL because `trade-history.ts` does not exist.

- [ ] **Step 3: Implement the panel**

Use native buttons and DOM `textContent` for all server values:

```ts
export interface TradeHistoryPanel {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

export function createTradeHistory(parent: HTMLElement, deps: {
  signedIn: () => boolean;
  flush: () => Promise<void>;
  load: (cursor?: string) => Promise<TradeHistoryPage>;
}): TradeHistoryPanel {
  const overlay = document.createElement("div");
  overlay.className = "trade-history-overlay";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <section class="trade-history-panel" role="dialog" aria-modal="true" aria-labelledby="trade-history-title">
      <header><h2 id="trade-history-title">History</h2><button type="button" data-history="close" aria-label="Close history">✕</button></header>
      <div class="trade-history-body" aria-live="polite"></div>
    </section>`;
  parent.appendChild(overlay);
  const body = overlay.querySelector(".trade-history-body") as HTMLElement;
  let cursor: string | null = null;
  let items: TradeHistoryItem[] = [];

  const sol = (base: number) => `${(base / 1e9).toFixed(3)} SOL`;
  const price = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 4 });

  function render() {
    body.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = "No settled trades yet.";
      body.appendChild(empty);
      return;
    }
    for (const trade of items) {
      const row = document.createElement("article");
      row.dataset.tradeId = trade.id;
      row.className = "trade-history-row";
      const pnl = `${trade.pnlBase >= 0 ? "+" : "-"}${sol(Math.abs(trade.pnlBase))}`;
      row.innerHTML = `<div class="trade-history-main"></div><div class="trade-history-values"></div>`;
      (row.children[0] as HTMLElement).textContent = `${trade.asset} · ${trade.dir === 1 ? "LONG" : "SHORT"} · ${trade.lev}× · ${trade.outcome.toUpperCase()}`;
      (row.children[1] as HTMLElement).textContent = `${sol(trade.stakeBase)} · ${price(trade.entryPrice)} → ${price(trade.exitPrice)} · ${pnl}`;
      body.appendChild(row);
    }
    if (cursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.dataset.history = "more";
      more.textContent = "Load more";
      more.addEventListener("click", () => { void loadPage(cursor, true); });
      body.appendChild(more);
    }
  }

  async function loadPage(next?: string, append = false) {
    body.textContent = append ? "Loading more…" : "Loading history…";
    try {
      const page = await deps.load(next);
      items = append ? [...items, ...page.items] : page.items;
      cursor = page.nextCursor;
      render();
    } catch {
      body.replaceChildren();
      const message = document.createElement("p");
      message.textContent = "Could not load history.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.history = "retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => { void loadPage(); });
      body.append(message, retry);
    }
  }

  const close = () => { overlay.style.display = "none"; };
  overlay.querySelector('[data-history="close"]')?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

  return {
    async open() {
      overlay.style.display = "flex";
      items = [];
      cursor = null;
      if (!deps.signedIn()) {
        body.textContent = "Sign in to view your trade history.";
        return;
      }
      await deps.flush().catch(() => {});
      await loadPage();
    },
    close,
    isOpen: () => overlay.style.display !== "none",
  };
}
```

Inject a single style element with responsive neon panel, row, positive/negative PnL, scroll, focus, and safe-area rules. Keep every selector under `.trade-history-*` so it cannot alter existing HUD styles.

```ts
const style = document.createElement("style");
style.textContent = `
  .trade-history-overlay{position:fixed;inset:0;z-index:42;display:none;align-items:center;justify-content:center;
    padding:18px;background:rgba(5,3,16,.78);backdrop-filter:blur(5px);pointer-events:auto}
  .trade-history-panel{width:min(680px,96vw);max-height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden;
    border:1px solid rgba(39,231,255,.42);border-radius:18px;background:rgba(12,10,26,.96);
    box-shadow:0 24px 70px rgba(0,0,0,.68),0 0 28px rgba(39,231,255,.12);color:var(--ink)}
  .trade-history-panel header{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(132,150,224,.22)}
  .trade-history-panel h2{flex:1;margin:0;font:800 17px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}
  .trade-history-panel button{min-height:40px;padding:10px 14px;border:1px solid rgba(39,231,255,.38);border-radius:10px;
    background:rgba(30,24,62,.82);color:var(--ink);font:700 11px/1 'Chakra Petch',ui-monospace,monospace;cursor:pointer}
  .trade-history-panel button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
  .trade-history-body{display:flex;flex-direction:column;gap:10px;min-height:150px;overflow:auto;padding:14px 18px max(18px,env(safe-area-inset-bottom))}
  .trade-history-body>p{margin:auto;text-align:center;color:var(--mut);font:600 12px/1.5 'Chakra Petch',ui-monospace,monospace}
  .trade-history-row{display:grid;gap:7px;padding:13px 14px;border:1px solid rgba(132,150,224,.22);border-radius:12px;background:rgba(18,14,40,.72)}
  .trade-history-main{font:800 12px/1.25 'Chakra Petch',ui-monospace,monospace;color:var(--cyan);letter-spacing:.04em}
  .trade-history-values{font:600 11px/1.45 'Chakra Petch',ui-monospace,monospace;color:rgba(226,230,255,.82)}
  @media (max-width:520px){
    .trade-history-overlay{align-items:flex-end;padding:0}
    .trade-history-panel{width:100%;max-height:82vh;border-radius:20px 20px 0 0}
    .trade-history-values{font-size:10px}
  }`;
document.head.appendChild(style);
```

- [ ] **Step 4: Run UI tests and commit**

Run: `npm test -- src/ui/trade-history.test.ts`

Expected: PASS.

```bash
git add redline3d/src/ui/trade-history.ts redline3d/src/ui/trade-history.test.ts
git commit -m "feat(ui): add account trade history panel"
```

---

### Task 6: Connect authoritative settlements to History

**Files:**
- Modify: `redline3d/src/chain/game-session.ts`
- Modify: `redline3d/src/chain/game-session.test.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: menu policy, recorder, History panel, API, and car-picker features from earlier tasks.
- Produces: signed-in settlement recording across close, crank poll, flip, and leverage terminal paths.

- [ ] **Step 1: Write a failing settlement-payload test**

In `game-session.test.ts`, strengthen an existing `onSettled` test:

```ts
expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
  outcomeName: "liq",
  payout: 0n,
  exitHuman: 60000,
}));
```

- [ ] **Step 2: Run the focused session test and verify RED**

Run: `npm test -- src/chain/game-session.test.ts`

Expected: FAIL if the public callback type or terminal mock drops `exitHuman`.

- [ ] **Step 3: Preserve exit price in the callback contract**

Change the type to:

```ts
export type SettledInfo = Pick<SettledRound, "outcome" | "outcomeName" | "payout" | "exitHuman">;
```

All existing terminal sources structurally carry `exitHuman`; update only test mocks that omit it.

- [ ] **Step 4: Add the runtime menu policy and History components in `main.ts`**

Add imports:

```ts
import { showLocalEconomyMenu } from "./core/menu-visibility";
import { createTradeHistoryRecorder } from "./core/trade-history-recorder";
import { createTradeHistory } from "./ui/trade-history";
```

After `api` is created:

```ts
const tradeRecorder = createTradeHistoryRecorder({
  api,
  wallet: () => session.address(),
});

const tradeHistory = createTradeHistory(hudRoot, {
  signedIn: () => identity?.mode === "privy" && signedIn,
  flush: () => tradeRecorder.flush(),
  load: (cursor) => api.listTrades(cursor),
});

const capacitorNative = (globalThis as {
  Capacitor?: { isNativePlatform?: () => boolean };
}).Capacitor?.isNativePlatform?.() === true;

const showGarageAndUpgrades = showLocalEconomyMenu({
  dev: import.meta.env.DEV,
  hostname: globalThis.location?.hostname ?? "",
  native: capacitorNative,
});
```

Pass a final menu-features argument into `createCarPicker`:

```ts
{
  showGarageAndUpgrades,
  onHistory: () => { void tradeHistory.open(); },
}
```

Add `tradeHistory.isOpen()` to `controls.setKeyLaunchBlocked`.

- [ ] **Step 5: Start the active draft only after confirmed open**

Immediately after `opened = await session.open(...)` has succeeded and before the local engine launches:

```ts
tradeRecorder.begin({
  asset,
  dir,
  lev,
  stakeBase: unitsToBase(playAmount),
  entryPrice: opened.entryHuman,
  openedAt: new Date((opened.entryTs ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
});
```

Do not call `begin` from `launchPractice`.

- [ ] **Step 6: Complete the draft from the single settlement sink**

Change the signature and add recording near the start of `finalizeSettled`, after the `roundActive` idempotency guard:

```ts
function finalizeSettled(info: { outcome: number; outcomeName: string; payout: bigint; exitHuman: number }) {
  if (!roundActive) return;
  roundActive = false;
  tradeRecorder.complete({
    outcome: info.outcomeName as "cashout" | "cap" | "liq" | "time",
    payoutBase: Number(info.payout),
    exitPrice: info.exitHuman,
  });
  void tradeRecorder.flush();
```

After successful `syncAccount`, call `void tradeRecorder.flush()` so an offline outbox retries when authentication returns.

- [ ] **Step 7: Run focused integration tests and builds**

Run: `npm test -- src/chain/game-session.test.ts src/core/trade-history-recorder.test.ts src/ui/trade-history.test.ts src/ui/carpicker.test.ts src/core/menu-visibility.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add redline3d/src/chain/game-session.ts redline3d/src/chain/game-session.test.ts redline3d/src/main.ts
git commit -m "feat: record confirmed trades in account history"
```

---

### Task 7: Full verification and browser acceptance

**Files:**
- Modify only files required by a failing verification test.

**Interfaces:**
- Verifies the complete feature and its non-economic trust boundary.

- [ ] **Step 1: Run all automated suites**

Run in `redline3d`: `npm test -- --run`

Expected: every client test passes; only explicitly gated tests may remain skipped.

Run in `server`: `npm test -- --run`

Expected: every server test passes. If parallel PGlite load hits the default timeout, rerun only those files serially with a larger test timeout and report both results.

Run in `server`: `npm run build`

Expected: PASS.

Run in `redline3d`: `npm run build`

Expected: PASS.

- [ ] **Step 2: Verify schema migration from a fresh database**

Run in `server`: `npm test -- src/db/runtime.test.ts src/services/trade-history.test.ts src/test/trade-history-routes.test.ts`

Expected: PASS with `trade_history` available after migrations.

- [ ] **Step 3: Browser-check localhost behavior**

Start or reuse Vite on port 3333. Open `http://localhost:3333` with the in-app browser.

Confirm:

- Hamburger menu contains Garage, Upgrades, and History.
- History opens and shows the signed-out state for a guest.
- Enter or Space does not launch a round while History is open.
- History closes through its button and backdrop.

- [ ] **Step 4: Browser-check production behavior**

Serve the production `dist` on a non-development preview server. Confirm:

- Hamburger menu contains History.
- Hamburger menu does not contain Garage or Upgrades.
- The native detection branch is covered by the policy unit test even though the desktop browser is not Capacitor.

- [ ] **Step 5: Confirm the trust boundary by source inspection**

Run:

```bash
rg -n "tradeHistory|trade_history|recordTrade|listTrades" server/src redline3d/src
```

Expected: server usage is limited to schema, service, HTTP wiring, and tests. No ledger, withdrawal, reward, inventory, upgrade, entitlement, or settlement service imports the history service.

- [ ] **Step 6: Inspect working tree and commit verification fixes if any**

Run: `git status --short`

Expected: `.claude/launch.json` remains untouched by this work. If verification required code changes, stage each explicitly named feature file shown by `git status`, verify the staged diff with `git diff --cached --check`, and commit with `git commit -m "test: verify account trade history"`. If verification required no changes, do not create an empty commit.

- [ ] **Step 7: Final completion check**

Run: `git log -6 --oneline`

Expected: separate commits exist for menu policy, server persistence, server API, client outbox, History UI, and main integration. Do not stage or commit `.claude/launch.json`.
