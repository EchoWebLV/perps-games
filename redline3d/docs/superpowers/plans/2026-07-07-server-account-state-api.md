# Server Account-State API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@perps/server` so a player's **coins, scrap, and cars** live on the server keyed by their account, giving cross-device continuity once the client (Plan 2) points at it.

**Architecture:** Reuse the existing append-only `ledgerEntries` for coins **and** a new `scrap` asset (idempotent deltas by `(asset,reason,ref)`). Convert the unlock-only `inventory` table to a **counted** collection (dupes stack, melt sheds spares, last copy kept). Add read (`/v1/me` extended) + mutation endpoints (coins/scrap earn+spend, inventory grant/melt) + a seed-if-empty `/v1/migrate`. All behind the existing `requireUser` Bearer/dev auth.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, Postgres (PGlite in tests), Zod, Vitest.

**Scope note:** This is Plan 1 of 3 for the "thin slice both" cross-platform pillar (see `docs/superpowers/specs/2026-07-07-crossplatform-privy-account-design.md`). Plan 2 = client integration (api.ts + Privy→session/bind convergence + route local stores through the server with a localStorage cache). Plan 3 = cross-platform shell (branding, WebView login, perf, APK/PWA). Coins/scrap use idempotent refs; car grant/melt are **not** ref-idempotent by design (the client never auto-retries non-auth calls — see `redline3d/src/core/api.ts` `call()`), which keeps the schema minimal for soft, non-withdrawable state.

---

## File Structure

- Modify `server/src/db/schema.ts` — add `"scrap"` to the `ledgerAsset` enum; add `count` to the `inventory` table.
- Modify `server/src/services/ledger.ts` — add `"scrap"` to the `Asset` type.
- Modify `server/src/services/inventory.ts` — rewrite for a counted collection (grant/melt/count/list/owns).
- Modify `server/src/http/routes.ts` — extend `/v1/me`; add coins/scrap/inventory mutation endpoints + `/v1/migrate`.
- Create `server/drizzle/00NN_*.sql` — generated migrations (via `npm run db:generate`).
- Create tests: `server/src/test/scrap-ledger.test.ts`, `server/src/test/inventory-counted.test.ts`, `server/src/test/account-routes.test.ts`, `server/src/test/migrate.test.ts`.

All server commands run from `server/`.

---

## Task 1: Scrap ledger asset

**Files:**
- Modify: `server/src/db/schema.ts:40`
- Modify: `server/src/services/ledger.ts:4`
- Create: `server/src/test/scrap-ledger.test.ts`
- Create: `server/drizzle/00NN_*.sql` (generated)

- [ ] **Step 1: Write the failing test**

Create `server/src/test/scrap-ledger.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("scrap ledger asset", () => {
  let ctx: TestCtx;
  let userId: string;
  afterEach(async () => { await ctx?.close(); });

  it("credits, debits, and reads a scrap balance independent of coins", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;

    await ctx.ledger.credit(userId, "scrap", 25, "scrap_earn", "r1");
    await ctx.ledger.credit(userId, "coin", 100, "earn", "c1");
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(25);
    expect(await ctx.ledger.balance(userId, "coin")).toBe(100);

    await ctx.ledger.debit(userId, "scrap", 10, "scrap_spend", "r2");
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(15);
  });

  it("is idempotent on (asset, reason, ref)", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:bob")).id;
    await ctx.ledger.credit(userId, "scrap", 5, "scrap_earn", "dup");
    await ctx.ledger.credit(userId, "scrap", 5, "scrap_earn", "dup"); // replay swallowed
    expect(await ctx.ledger.balance(userId, "scrap")).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/scrap-ledger.test.ts`
Expected: FAIL — TypeScript rejects `"scrap"` as an `Asset`, and/or the DB rejects the enum value.

- [ ] **Step 3: Add the enum value + type**

In `server/src/db/schema.ts` line 40, change:

```ts
export const ledgerAsset = pgEnum("ledger_asset", ["coin", "cash", "scrap"]);
```

In `server/src/services/ledger.ts` line 4, change:

```ts
export type Asset = "coin" | "cash" | "scrap";
```

- [ ] **Step 4: Generate the migration**

Run: `cd server && npm run db:generate`
Expected: a new file `server/drizzle/00NN_*.sql` containing `ALTER TYPE "public"."ledger_asset" ADD VALUE 'scrap';`. Commit it as part of this task.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/scrap-ledger.test.ts`
Expected: PASS (both tests). The harness applies migrations to a fresh PGlite DB, so the enum value is present.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.ts server/src/services/ledger.ts server/src/test/scrap-ledger.test.ts server/drizzle
git commit -m "feat(server): add scrap ledger asset"
```

---

## Task 2: Counted inventory

**Files:**
- Modify: `server/src/db/schema.ts:146-159`
- Modify: `server/src/services/inventory.ts` (full rewrite)
- Create: `server/src/test/inventory-counted.test.ts`
- Create: `server/drizzle/00NN_*.sql` (generated)

- [ ] **Step 1: Write the failing test**

Create `server/src/test/inventory-counted.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

describe("counted inventory", () => {
  let ctx: TestCtx;
  let userId: string;
  afterEach(async () => { await ctx?.close(); });

  it("stacks duplicate grants and reports the count", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:alice")).id;

    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: true, count: 1 });
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: false, count: 2 });
    expect(await ctx.inventory.count(userId, "orion")).toBe(2);
    expect(await ctx.inventory.owns(userId, "orion")).toBe(true);
  });

  it("melt sheds a spare but never the last copy", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:bob")).id;
    await ctx.inventory.grant(userId, "skull");
    await ctx.inventory.grant(userId, "skull"); // count 2
    expect(await ctx.inventory.melt(userId, "skull")).toEqual({ melted: true, count: 1 });
    expect(await ctx.inventory.melt(userId, "skull")).toEqual({ melted: false, count: 1 });
  });

  it("lists owned cars with counts", async () => {
    ctx = await makeTestDb();
    userId = (await ctx.users.upsertByExternalId("dev:cara")).id;
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "clowncar");
    await ctx.inventory.grant(userId, "clowncar");
    const list = (await ctx.inventory.list(userId)).map((r) => ({ carId: r.carId, count: r.count })).sort((a, b) => a.carId.localeCompare(b.carId));
    expect(list).toEqual([{ carId: "clowncar", count: 2 }, { carId: "orion", count: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/inventory-counted.test.ts`
Expected: FAIL — `grant` returns a boolean (not `{isNew,count}`), `melt`/`count` don't exist, `r.count` is undefined.

- [ ] **Step 3: Add the `count` column**

In `server/src/db/schema.ts`, in the `inventory` table (currently lines 146-159), add a `count` column after `carId`:

```ts
export const inventory = pgTable(
  "inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    carId: text("car_id").notNull(),
    count: integer("count").notNull().default(1),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownedIdx: uniqueIndex("inventory_user_car_idx").on(t.userId, t.carId),
  }),
);
```

(`integer` is already imported at the top of the file.)

- [ ] **Step 4: Rewrite the inventory service**

Replace the entire contents of `server/src/services/inventory.ts`:

```ts
import { eq, and, gt, sql } from "drizzle-orm";
import { inventory, type InventoryRow } from "../db/schema.js";

export function makeInventory(db: any) {
  async function count(userId: string, carId: string): Promise<number> {
    const rows = await db
      .select({ count: inventory.count })
      .from(inventory)
      .where(and(eq(inventory.userId, userId), eq(inventory.carId, carId)))
      .limit(1);
    return rows[0]?.count ?? 0;
  }

  return {
    /** grant a copy; dupes stack. isNew = the 0->1 transition (a genuinely new unlock). */
    async grant(userId: string, carId: string): Promise<{ isNew: boolean; count: number }> {
      const rows = await db
        .insert(inventory)
        .values({ userId, carId, count: 1 })
        .onConflictDoUpdate({
          target: [inventory.userId, inventory.carId],
          set: { count: sql`${inventory.count} + 1` },
        })
        .returning({ count: inventory.count });
      const c = rows[0].count as number;
      return { isNew: c === 1, count: c };
    },

    /** shed one spare; the last copy is never lost. */
    async melt(userId: string, carId: string): Promise<{ melted: boolean; count: number }> {
      const rows = await db
        .update(inventory)
        .set({ count: sql`${inventory.count} - 1` })
        .where(and(eq(inventory.userId, userId), eq(inventory.carId, carId), gt(inventory.count, 1)))
        .returning({ count: inventory.count });
      if (rows[0]) return { melted: true, count: rows[0].count as number };
      return { melted: false, count: await count(userId, carId) };
    },

    count,

    async list(userId: string): Promise<InventoryRow[]> {
      return db.select().from(inventory).where(eq(inventory.userId, userId));
    },

    async owns(userId: string, carId: string): Promise<boolean> {
      return (await count(userId, carId)) > 0;
    },
  };
}

export type Inventory = ReturnType<typeof makeInventory>;
```

- [ ] **Step 5: Generate the migration**

Run: `cd server && npm run db:generate`
Expected: a new `server/drizzle/00NN_*.sql` with `ALTER TABLE "inventory" ADD COLUMN "count" integer DEFAULT 1 NOT NULL;`.

- [ ] **Step 6: Update the stale unlock-only test**

The existing `server/src/test/inventory.test.ts` asserts `grant` returns a boolean. Update its two `grant` assertions to the new shape so the suite stays green:

```ts
  it("grants a car once", async () => {
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: true, count: 1 });
    expect(await ctx.inventory.owns(userId, "orion")).toBe(true);
  });

  it("granting an owned car stacks a duplicate", async () => {
    await ctx.inventory.grant(userId, "orion");
    expect(await ctx.inventory.grant(userId, "orion")).toEqual({ isNew: false, count: 2 });
    expect((await ctx.inventory.list(userId)).length).toBe(1);
  });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && npx vitest run src/test/inventory-counted.test.ts src/test/inventory.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema.ts server/src/services/inventory.ts server/src/test/inventory-counted.test.ts server/src/test/inventory.test.ts server/drizzle
git commit -m "feat(server): counted car inventory (stack dupes, melt spares)"
```

---

## Task 3: Extend `/v1/me` with coins, scrap, and car counts

**Files:**
- Modify: `server/src/http/routes.ts:79-96`
- Create: `server/src/test/account-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/test/account-routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("GET /v1/me account state", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("returns coins, scrap, and cars with counts", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 40, "earn", "c1");
    await ctx.ledger.credit(userId, "scrap", 7, "scrap_earn", "s1");
    await ctx.inventory.grant(userId, "orion");
    await ctx.inventory.grant(userId, "orion");

    const res = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coins).toBe(40);
    expect(body.scrap).toBe(7);
    expect(body.cars).toEqual([{ carId: "orion", count: 2, acquiredAt: expect.anything() }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: FAIL — `body.coins`/`body.scrap` are undefined and `cars` has no `count`.

- [ ] **Step 3: Extend the `/v1/me` handler**

In `server/src/http/routes.ts`, replace the `/v1/me` handler (lines 79-96) with:

```ts
  server.get("/v1/me", { preHandler: requireUser }, async (req) => {
    const userId = req.userId!;
    // soft-coin seeding: idempotent on (signup_faucet, userId) — safe to attempt every call
    if (deps.signupFaucet) {
      await deps.ledger.credit(userId, "coin", deps.startBalance, "signup_faucet", userId);
    }
    const [balance, coins, scrap, rows, openRoundId] = await Promise.all([
      deps.ledger.balance(userId, deps.stakeAsset),
      deps.ledger.balance(userId, "coin"),
      deps.ledger.balance(userId, "scrap"),
      deps.inventory.list(userId),
      deps.rounds.getOpenRoundId(userId),
    ]);
    return {
      userId,
      balance,
      coins,
      scrap,
      cars: rows.map((r) => ({ carId: r.carId, count: r.count, acquiredAt: r.acquiredAt })),
      openRoundId,
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes.ts server/src/test/account-routes.test.ts
git commit -m "feat(server): /v1/me returns coins, scrap, car counts"
```

---

## Task 4: Coins earn/spend endpoints

**Files:**
- Modify: `server/src/http/routes.ts` (add near `/v1/balance`)
- Modify: `server/src/test/account-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/test/account-routes.test.ts` (inside the file, new `describe`):

```ts
describe("coins earn/spend", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("earns coins (idempotent on ref) and spends them", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const earn = await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 30, ref: "e1" } });
    expect(earn.statusCode).toBe(200);
    expect(earn.json().coins).toBe(30);
    // replay same ref → swallowed
    await ctx.server.inject({ method: "POST", url: "/v1/coins/earn", headers: H, payload: { amount: 30, ref: "e1" } });

    const spend = await ctx.server.inject({ method: "POST", url: "/v1/coins/spend", headers: H, payload: { amount: 12, ref: "s1" } });
    expect(spend.statusCode).toBe(200);
    expect(spend.json().coins).toBe(18);
  });

  it("402s when spending more coins than the balance", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/coins/spend", headers: H, payload: { amount: 5, ref: "x" } });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("insufficient_balance");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: FAIL — the `/v1/coins/*` routes 404.

- [ ] **Step 3: Add the endpoints**

In `server/src/http/routes.ts`, add a Zod schema near the other `const ... = z.object(...)` declarations (around line 36):

```ts
const CoinDelta = z.object({ amount: z.number().int().positive(), ref: z.string().min(1).max(200) });
```

Then, inside `registerRoutes`, add after the `/v1/balance` handler (after line 72):

```ts
  server.post("/v1/coins/earn", { preHandler: requireUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    // NOTE: the ledger idempotency index is (asset, reason, ref) GLOBAL, so the ref MUST be
    // namespaced by user or one user's ref could swallow another's credit. Prefix with userId.
    await deps.ledger.credit(req.userId!, "coin", p.data.amount, "earn", `${req.userId!}:${p.data.ref}`);
    return { coins: await deps.ledger.balance(req.userId!, "coin") };
  });

  server.post("/v1/coins/spend", { preHandler: requireUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await deps.ledger.debit(req.userId!, "coin", p.data.amount, "spend", `${req.userId!}:${p.data.ref}`);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      throw e;
    }
    return { coins: await deps.ledger.balance(req.userId!, "coin") };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes.ts server/src/test/account-routes.test.ts
git commit -m "feat(server): coins earn/spend endpoints"
```

---

## Task 5: Scrap earn/spend endpoints

**Files:**
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/test/account-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/test/account-routes.test.ts`:

```ts
describe("scrap earn/spend", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("earns and spends scrap independently of coins", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const earn = await ctx.server.inject({ method: "POST", url: "/v1/scrap/earn", headers: H, payload: { amount: 5, ref: "se1" } });
    expect(earn.statusCode).toBe(200);
    expect(earn.json().scrap).toBe(5);

    const spend = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: H, payload: { amount: 2, ref: "ss1" } });
    expect(spend.statusCode).toBe(200);
    expect(spend.json().scrap).toBe(3);
  });

  it("402s when spending more scrap than the balance", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({ method: "POST", url: "/v1/scrap/spend", headers: H, payload: { amount: 9, ref: "z" } });
    expect(res.statusCode).toBe(402);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: FAIL — the `/v1/scrap/*` routes 404.

- [ ] **Step 3: Add the endpoints**

In `server/src/http/routes.ts`, reusing the `CoinDelta` schema from Task 4, add after the coins endpoints:

```ts
  server.post("/v1/scrap/earn", { preHandler: requireUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    await deps.ledger.credit(req.userId!, "scrap", p.data.amount, "scrap_earn", `${req.userId!}:${p.data.ref}`);
    return { scrap: await deps.ledger.balance(req.userId!, "scrap") };
  });

  server.post("/v1/scrap/spend", { preHandler: requireUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      await deps.ledger.debit(req.userId!, "scrap", p.data.amount, "scrap_spend", `${req.userId!}:${p.data.ref}`);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      throw e;
    }
    return { scrap: await deps.ledger.balance(req.userId!, "scrap") };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes.ts server/src/test/account-routes.test.ts
git commit -m "feat(server): scrap earn/spend endpoints"
```

---

## Task 6: Inventory grant/melt endpoints

**Files:**
- Modify: `server/src/http/routes.ts`
- Modify: `server/src/test/account-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/test/account-routes.test.ts`:

```ts
describe("inventory grant/melt endpoints", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("grants (stacking) and melts (keep-last)", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const g1 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: H, payload: { carId: "orion" } });
    expect(g1.json()).toEqual({ carId: "orion", isNew: true, count: 1 });
    const g2 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/grant", headers: H, payload: { carId: "orion" } });
    expect(g2.json()).toEqual({ carId: "orion", isNew: false, count: 2 });

    const m1 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/melt", headers: H, payload: { carId: "orion" } });
    expect(m1.json()).toEqual({ carId: "orion", melted: true, count: 1 });
    const m2 = await ctx.server.inject({ method: "POST", url: "/v1/inventory/melt", headers: H, payload: { carId: "orion" } });
    expect(m2.json()).toEqual({ carId: "orion", melted: false, count: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: FAIL — the `/v1/inventory/grant|melt` routes 404.

- [ ] **Step 3: Add the endpoints**

In `server/src/http/routes.ts`, add a Zod schema near the others:

```ts
const CarRef = z.object({ carId: z.string().min(1) });
```

Then inside `registerRoutes`, after the `/v1/inventory` GET handler (after line 77):

```ts
  server.post("/v1/inventory/grant", { preHandler: requireUser }, async (req, reply) => {
    const p = CarRef.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.inventory.grant(req.userId!, p.data.carId);
    return { carId: p.data.carId, isNew: r.isNew, count: r.count };
  });

  server.post("/v1/inventory/melt", { preHandler: requireUser }, async (req, reply) => {
    const p = CarRef.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const r = await deps.inventory.melt(req.userId!, p.data.carId);
    return { carId: p.data.carId, melted: r.melted, count: r.count };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/account-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/http/routes.ts server/src/test/account-routes.test.ts
git commit -m "feat(server): inventory grant/melt endpoints"
```

---

## Task 7: First-bind migrate endpoint (seed-if-empty)

**Files:**
- Modify: `server/src/http/routes.ts`
- Create: `server/src/test/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/test/migrate.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestCtx } from "./harness.js";

const H = { "x-dev-user": "alice", "content-type": "application/json" };

describe("POST /v1/migrate (seed-if-empty)", () => {
  let ctx: TestCtx;
  afterEach(async () => { await ctx?.close(); });

  it("seeds an empty account from the local save", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seeded: true });

    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    const body = me.json();
    expect(body.coins).toBe(250);
    expect(body.scrap).toBe(30);
    expect(body.cars.find((c: any) => c.carId === "clowncar").count).toBe(2);
  });

  it("refuses to seed (and never sums) when the account already has state", async () => {
    ctx = await makeTestDb({ signupFaucet: false });
    const userId = (await ctx.users.upsertByExternalId("dev:alice")).id;
    await ctx.ledger.credit(userId, "coin", 500, "earn", "pre");

    const res = await ctx.server.inject({
      method: "POST", url: "/v1/migrate", headers: H,
      payload: { coins: 250, scrap: 30, cars: {} },
    });
    expect(res.json()).toEqual({ seeded: false, reason: "account_not_empty" });
    const me = await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H });
    expect(me.json().coins).toBe(500); // unchanged, not 750
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/test/migrate.test.ts`
Expected: FAIL — `/v1/migrate` 404s.

- [ ] **Step 3: Add the endpoint**

In `server/src/http/routes.ts`, add a Zod schema near the others:

```ts
const MigrateBody = z.object({
  coins: z.number().int().min(0).max(1_000_000_000),
  scrap: z.number().int().min(0).max(1_000_000_000),
  // bound both the per-car count and the number of cars so a tiny payload can't drive
  // unbounded DB work (the endpoint is reachable with a free anonymous session).
  cars: z
    .record(z.string().min(1), z.number().int().positive().max(1000))
    .refine((c) => Object.keys(c).length <= 64, { message: "too_many_cars" }),
});
```

Then inside `registerRoutes`, after the inventory endpoints:

```ts
  server.post("/v1/migrate", { preHandler: requireUser }, async (req, reply) => {
    const p = MigrateBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    const userId = req.userId!;
    const [coins, scrap, cars] = await Promise.all([
      deps.ledger.balance(userId, "coin"),
      deps.ledger.balance(userId, "scrap"),
      deps.inventory.list(userId),
    ]);
    if (coins > 0 || scrap > 0 || cars.length > 0) {
      return { seeded: false, reason: "account_not_empty" };
    }
    if (p.data.coins > 0) await deps.ledger.credit(userId, "coin", p.data.coins, "migrate_seed", `migrate:${userId}`);
    if (p.data.scrap > 0) await deps.ledger.credit(userId, "scrap", p.data.scrap, "scrap_migrate_seed", `migrate:${userId}`);
    for (const [carId, n] of Object.entries(p.data.cars)) {
      await deps.inventory.grant(userId, carId, n); // one counted write per car, not n writes
    }
    return { seeded: true };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd server && npx vitest run && npm run build`
Expected: all tests PASS; `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/routes.ts server/src/test/migrate.test.ts
git commit -m "feat(server): seed-if-empty account migration endpoint"
```

---

## Self-Review

**Spec coverage:** Coins (Tasks 4), scrap (Tasks 1, 5), counted cars (Tasks 2, 6), read (Task 3), first-bind seed-if-empty (Task 7), idempotent deltas for coins/scrap (Tasks 1, 4, 5), non-tradable scrap kept as a soft ledger asset (Task 1). Client integration and mobile shell are Plans 2 and 3 — out of scope here by design.

**Placeholder scan:** none — every step has real code or an exact command with expected output.

**Type consistency:** `grant` → `{isNew, count}` and `melt` → `{melted, count}` used identically in the service (Task 2), the route handlers (Task 6), and their tests. `Asset` includes `"scrap"` (Task 1) and is used in every ledger call. `CoinDelta` (Task 4) is reused by scrap (Task 5); `CarRef` (Task 6) and `MigrateBody` (Task 7) are defined before use.

**Migration caveat:** `ALTER TYPE ... ADD VALUE` (Task 1) cannot run inside a transaction on some Postgres setups. The harness applies migrations to PGlite in Step 5's test run — if it errors there, split the enum change into its own migration file so it applies standalone. TDD's verify-fail/verify-pass steps will catch it before it reaches the app.
