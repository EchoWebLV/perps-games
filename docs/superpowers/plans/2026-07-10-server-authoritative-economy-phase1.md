# Server-Authoritative Economy (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server the authoritative source of truth for upgrade levels and expose an `entitlementsFor` oracle (the perk envelope a player is allowed), backed by a shared, single-source perk-math module — the prerequisite that lets Phase 2's on-chain `open` co-sign mean something.

**Architecture:** A new pure `@perps/engine/entitlements` module owns the perk-envelope math and car→perk registry (today spread across `redline3d` `upgrades.ts` + `main.ts`). The server gains an authoritative `upgrade_levels` table, a coin-debiting `buy` path (levels can't be faked or bought for free), a rolling earn-rate cap, and an `entitlementsFor(userId, carId)` service that feeds the envelope from authoritative inventory + levels. The client keeps its local UX but syncs levels through the server (server wins), and existing local levels migrate up so no one loses upgrades.

**Tech Stack:** TypeScript (ESM), `@perps/engine` (shared pure module), Fastify + Drizzle (Postgres) server, Vitest, drizzle-kit migrations.

**Scope note:** Phase 1 only. The client does NOT yet call an `/authorize` endpoint or build its open request from the shared module — that is Phase 2 (the co-sign), which also refactors the client to *consume* this module. Phase 1 locks parity via shared test vectors instead. Do not build any on-chain change here.

**Out of scope (do not touch):** the `onchain/` program; the "cash payouts not collateralized" behavior; the client's open()/settlement path.

---

## File Structure

**New files**
- `packages/engine/src/entitlements.ts` — perk-envelope math + constants + car→perk registry (single source of truth).
- `packages/engine/src/entitlements.test.ts` — vectors for the envelope + parity assertions vs the on-chain global clamps.
- `server/src/services/upgrades.ts` — authoritative per-user upgrade levels (get/list/buy).
- `server/src/services/upgrades.test.ts`
- `server/src/services/entitlements.ts` — `entitlementsFor(userId, carId)` oracle.
- `server/src/services/entitlements.test.ts`
- `server/src/services/earn-limit.ts` — rolling earn-rate cap helper.
- `server/src/services/earn-limit.test.ts`
- `server/drizzle/0014_*.sql` — generated migration for the new table + index (filename assigned by drizzle-kit).

**Modified files**
- `packages/engine/src/types.ts` — add the shared `CarAbility` type.
- `packages/engine/src/index.ts` + `packages/engine/package.json` — export the new subpath.
- `server/src/db/schema.ts` — add `upgrade_levels` table + a `(user_id, created_at)` index on `ledger_entries`.
- `server/src/http/routes.ts` — extend `GET /v1/me`; add `POST /v1/upgrades/buy`; extend `POST /v1/migrate`; wire the earn cap into `POST /v1/coins/earn` + `POST /v1/scrap/earn`.
- `server/src/index.ts` + `server/src/http/server.ts` — construct + inject the new services.
- `redline3d/src/core/api.ts` — add `me().levels`, `upgradesBuy`, `migrate(levels)`.
- `redline3d/src/core/account-sync.ts` — carry `levels` in hydrate/migrate/applyServer + a `levelBought` forwarder.
- `redline3d/src/ui/upgrades.ts` — hydrate levels from server; forward a purchase.

---

## Test harness reference (verified — use these exact APIs)

The server test harness is `server/src/test/harness.ts`. Do NOT invent helpers; use these:

- `makeTestDb(opts?): Promise<TestCtx>` where `TestCtx = { raw, db, users, ledger, inventory, rounds, feed, houseUserId, server, close }`. It boots a fresh in-memory pglite DB with migrations applied and a wired Fastify `server` (dev auth on).
- There is **no** `userId` returned. Create/fetch a user via `const u = await ctx.users.upsertByExternalId("dev:tester"); const userId = u.id;` (dev users are `dev:<name>`).
- HTTP auth in route tests is the header `{ "x-dev-user": "<name>" }`; call `await bindDevWallet(ctx, "<name>")` first to make that session wallet-bound (required by `requireWalletBoundUser`). Drive requests with `ctx.server.inject({ method, url, headers, payload })`.

**Service-test `beforeEach` idiom (use verbatim shape):**
```ts
import { makeTestDb, type TestCtx } from "../test/harness.js";
let ctx: TestCtx, userId: string;
beforeEach(async () => {
  ctx = await makeTestDb();
  userId = (await ctx.users.upsertByExternalId("dev:tester")).id;
  // use ctx.db, ctx.ledger, ctx.inventory directly; construct new services on ctx.db/ctx.ledger
});
```
Wherever the task snippets below write `makeLedger(db)` / `({ db, userId } = ...)`, substitute `ctx.ledger` / the idiom above.

**Harness must forward the new services (Task 7 dependency):** `makeTestDb` builds the server via `buildServer({...})` (harness lines 64-94). When Task 7 adds `upgrades`/`entitlements`/`earnLimit` to `buildServer`'s deps, also construct them in the harness and pass them here, or the new routes won't exist under test. Construct in-harness: `const upgrades = makeUpgrades(db, ledger); const entitlements = makeEntitlements({ inventory, upgrades }); const earnLimit = makeEarnLimit(db, { ceiling: 5000, windowMs: 60_000 });` and add them to the `buildServer({...})` call + the returned `TestCtx`.

---

## Task 1: Shared `CarAbility` type in the engine

**Files:**
- Modify: `packages/engine/src/types.ts`

- [ ] **Step 1: Read the current type file**

Run: `sed -n '1,40p' packages/engine/src/types.ts`
Note the existing exports (it is ~566 bytes; `Dir`, `Position`, `SettleReason`, etc.).

- [ ] **Step 2: Add the shared `CarAbility` union**

Append to `packages/engine/src/types.ts` (verbatim — this is the exact union from `redline3d/src/ui/carpicker.ts:7`, moved here so both client and server share one definition):

```ts
/** A car's special power. The perk-relevant abilities (nitro/skull/pinkRod/sixWheeler/airbag)
 *  drive the entitlement envelope; the rest are cosmetic/economy-only. Single source of truth —
 *  redline3d re-exports this instead of defining its own. */
export type CarAbility =
  | "laneBet" | "nitro" | "rainbow" | "skull" | "pinkRod" | "sixWheeler"
  | "cartRod" | "flux" | "swerve" | "slots" | "airbag" | "magnet";
```

- [ ] **Step 3: Verify the engine still type-checks**

Run: `cd packages/engine && npm run build`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/types.ts
git commit -m "feat(engine): share CarAbility type"
```

---

## Task 2: Shared entitlement module (`perkEnvelope` + car registry)

**Files:**
- Create: `packages/engine/src/entitlements.ts`
- Create: `packages/engine/src/entitlements.test.ts`
- Modify: `packages/engine/src/index.ts`, `packages/engine/package.json`

**Background (verified):** the client computes the envelope from `BASE_CONFIG` (RMAX 1000, MAXSEC 60, LIQ 0.2) plus per-level steps `turbo +50 / tank +6 / suspension −0.01` (`upgrades.ts:34-38`, `MAX_LEVEL=10`), and per-ability perks: Six Wheeler `HEAVY = {playCap 25, dur 1.5, lev 0.5}` (`main.ts:317`), Skull `graceSecs 2` (`main.ts:1096`), Pink Rod SL/TP allowed, Bedrock/airbag `refundFp 200_000` (`main.ts:1099`), Nitro `2×` (`nitro.ts:10`), default stake cap `10` (`controls.ts:4`). On-chain global clamps the envelope must never exceed: lev [10, 3000], dur [5, 180], liqFp [100_000, 200_000], grace ≤ 5, refund ≤ 200_000.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/entitlements.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { perkEnvelope, CAR_PERKS, MAX_UPGRADE_LEVEL, ONCHAIN } from "./entitlements";

const L0 = { turbo: 0, tank: 0, suspension: 0 };
const LMAX = { turbo: 10, tank: 10, suspension: 10 };

describe("perkEnvelope", () => {
  it("stock car, no upgrades → base envelope", () => {
    const e = perkEnvelope(L0, {});
    expect(e.maxLev).toBe(1000);          // BASE_CONFIG.RMAX
    expect(e.maxDurSecs).toBe(60);        // BASE_CONFIG.MAXSEC
    expect(e.minLiqFp).toBe(200_000);     // BASE_CONFIG.LIQ * 1e6
    expect(e.graceSecs).toBe(0);
    expect(e.slTpAllowed).toBe(false);
    expect(e.refundFp).toBe(0);
    expect(e.maxStakeUnits).toBe(10);
  });

  it("maxed upgrades → 1500× / 120s / 0.10 floor", () => {
    const e = perkEnvelope(LMAX, {});
    expect(e.maxLev).toBe(1500);          // 1000 + 50*10
    expect(e.maxDurSecs).toBe(120);       // 60 + 6*10
    expect(e.minLiqFp).toBe(100_000);     // (0.2 - 0.01*10) * 1e6
  });

  it("Cybertruck baseLev floors leverage at 1500 with no turbo", () => {
    expect(perkEnvelope(L0, { baseLev: 1500 }).maxLev).toBe(1500);
  });

  it("Orion nitro doubles the ceiling (transient headroom the co-sign must allow)", () => {
    expect(perkEnvelope(LMAX, { ability: "nitro" }).maxLev).toBe(3000); // 1500*2
  });

  it("Six Wheeler: half ceiling, +50% time, bigger stake cap", () => {
    const e = perkEnvelope(LMAX, { ability: "sixWheeler" });
    expect(e.maxLev).toBe(750);           // round(1500 * 0.5)
    expect(e.maxDurSecs).toBe(180);       // round(120 * 1.5)
    expect(e.maxStakeUnits).toBe(25);
  });

  it("Skull grants grace; Pink Rod grants SL/TP; Bedrock grants airbag refund", () => {
    expect(perkEnvelope(L0, { ability: "skull" }).graceSecs).toBe(2);
    expect(perkEnvelope(L0, { ability: "pinkRod" }).slTpAllowed).toBe(true);
    expect(perkEnvelope(L0, { ability: "airbag" }).refundFp).toBe(200_000);
  });

  it("NEVER exceeds the on-chain global clamps, for any car at max upgrades", () => {
    for (const car of Object.values(CAR_PERKS)) {
      const e = perkEnvelope(LMAX, car);
      expect(e.maxLev).toBeGreaterThanOrEqual(ONCHAIN.RMIN);
      expect(e.maxLev).toBeLessThanOrEqual(ONCHAIN.RMAX);
      expect(e.maxDurSecs).toBeGreaterThanOrEqual(ONCHAIN.MIN_DUR);
      expect(e.maxDurSecs).toBeLessThanOrEqual(ONCHAIN.MAX_DUR);
      expect(e.minLiqFp).toBeGreaterThanOrEqual(ONCHAIN.MIN_LIQ_FP);
      expect(e.minLiqFp).toBeLessThanOrEqual(ONCHAIN.MAX_LIQ_FP);
      expect(e.refundFp).toBeLessThanOrEqual(ONCHAIN.MAX_REFUND_FP);
    }
  });

  it("clamps out-of-range levels defensively", () => {
    expect(perkEnvelope({ turbo: 99, tank: -3, suspension: 999 }, {}).maxLev)
      .toBe(perkEnvelope({ turbo: MAX_UPGRADE_LEVEL, tank: 0, suspension: MAX_UPGRADE_LEVEL }, {}).maxLev);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/engine && npx vitest run src/entitlements.test.ts`
Expected: FAIL — cannot find module `./entitlements`.

- [ ] **Step 3: Implement `entitlements.ts`**

Create `packages/engine/src/entitlements.ts`:

```ts
import { BASE_CONFIG } from "./config";
import type { CarAbility } from "./types";

/** On-chain global clamps (mirror onchain/raider settle.rs + state.rs). The envelope is a
 *  per-player TIGHTENING inside these — it must never widen them. Kept here so the parity test
 *  can assert the two never diverge. */
export const ONCHAIN = {
  RMIN: 10, RMAX: 3000,
  MIN_DUR: 5, MAX_DUR: 180,
  MIN_LIQ_FP: 100_000, MAX_LIQ_FP: 200_000,
  MAX_REFUND_FP: 200_000,
} as const;

export const MAX_UPGRADE_LEVEL = 10;
/** per-level deltas (from redline3d upgrades.ts TRACKS) — the single source of truth now. */
export const UPGRADE_STEP = { turbo: 50, tank: 6, suspension: -0.01 } as const;
/** Six Wheeler "Heavy Load" (main.ts HEAVY_*), default stake cap (controls.ts DEFAULT_PLAY_CAP),
 *  Nitro multiplier (nitro.ts), Skull grace, Bedrock airbag refund. */
export const HEAVY = { playCap: 25, durMult: 1.5, levMult: 0.5 } as const;
export const DEFAULT_STAKE_UNITS = 10;
export const NITRO_MULT = 2;
export const SKULL_GRACE_SECS = 2;
export const AIRBAG_REFUND_FP = 200_000;

export interface UpgradeLevels { turbo: number; tank: number; suspension: number; }
export interface CarPerk { ability?: CarAbility; baseLev?: number; }
export interface PerkEnvelope {
  maxLev: number;       // max leverage the player may request/reach (incl. transient nitro headroom)
  maxDurSecs: number;   // max round duration
  minLiqFp: number;     // lowest liq floor allowed (SCALE units)
  graceSecs: number;    // Skull grace (0 if not entitled)
  slTpAllowed: boolean; // Pink Rod
  refundFp: number;     // Bedrock airbag (0 if not entitled)
  maxStakeUnits: number;// per-car stake cap in 0.01-SOL units
}

const clampLevel = (n: number) => Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(Number(n) || 0)));
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** The perk envelope a player is entitled to, from their upgrade levels + one car's perks.
 *  Mirrors the client's live computation (upgrades.ts + main.ts effRmax/effMaxSec) so a legit
 *  client request always validates, and is the authority the server signs against in Phase 2. */
export function perkEnvelope(levels: UpgradeLevels, car: CarPerk): PerkEnvelope {
  const turbo = clampLevel(levels.turbo);
  const tank = clampLevel(levels.tank);
  const susp = clampLevel(levels.suspension);
  const heavy = car.ability === "sixWheeler";

  const rmax = BASE_CONFIG.RMAX + UPGRADE_STEP.turbo * turbo;            // 1000 + 50*turbo
  const ceil = Math.max(rmax, car.baseLev ?? 0);                        // Cybertruck baseLev floor
  const nitro = car.ability === "nitro" ? NITRO_MULT : 1;              // transient burst headroom
  const maxLev = clampInt(ceil * (heavy ? HEAVY.levMult : 1) * nitro, ONCHAIN.RMIN, ONCHAIN.RMAX);

  const dur = (BASE_CONFIG.MAXSEC + UPGRADE_STEP.tank * tank) * (heavy ? HEAVY.durMult : 1);
  const maxDurSecs = clampInt(dur, ONCHAIN.MIN_DUR, ONCHAIN.MAX_DUR);

  const liq = (BASE_CONFIG.LIQ + UPGRADE_STEP.suspension * susp) * 1_000_000;
  const minLiqFp = clampInt(liq, ONCHAIN.MIN_LIQ_FP, ONCHAIN.MAX_LIQ_FP);

  return {
    maxLev, maxDurSecs, minLiqFp,
    graceSecs: car.ability === "skull" ? SKULL_GRACE_SECS : 0,
    slTpAllowed: car.ability === "pinkRod",
    refundFp: car.ability === "airbag" ? AIRBAG_REFUND_FP : 0,
    maxStakeUnits: heavy ? HEAVY.playCap : DEFAULT_STAKE_UNITS,
  };
}

/** Perk-relevant fields per car, keyed by the inventory `carId`. VERIFY the key format before
 *  filling: it MUST equal the `carId` string the client passes to `inventoryGrant` / the server
 *  `inventory` table stores (see Step 3a). Only cars with a perk-bearing ability or a baseLev need
 *  an entry; everything else falls through to `{}` (stock envelope). */
export const CAR_PERKS: Record<string, CarPerk> = {
  // Filled in Step 3a once the carId format is confirmed. Example shape:
  // "delorean": { ability: "flux" }, "cybertruck": { baseLev: 1500 }, "orion": { ability: "nitro" },
};

/** Look up a car's perks by inventory carId; unknown/stock cars → no perks. */
export const carPerk = (carId: string): CarPerk => CAR_PERKS[carId] ?? {};
```

- [ ] **Step 3a: Fill `CAR_PERKS` with the REAL carIds (verify, don't guess)**

Run: `grep -rn "inventoryGrant\|carGranted\|carId" redline3d/src/main.ts redline3d/src/ui/carpicker.ts | head -30`
Determine the exact `carId` string the client grants/stores (name? slug of name? an explicit id field?). Then populate `CAR_PERKS` using those exact keys, transcribing perks from `main.ts:428-465` `CAR_DEFS`. The perk-bearing cars are exactly: DeLorean `flux` (cosmetic — no envelope effect, omit or note), Cybertruck `baseLev:1500`, Orion `nitro`, Bedrock `airbag`, Clown Car `laneBet` (cosmetic), Skull `skull`, Pink Rod `pinkRod`, Six Wheeler `sixWheeler`. Only `baseLev`, `nitro`, `skull`, `pinkRod`, `sixWheeler`, `airbag` change the envelope — include those; abilities with no envelope effect may be omitted (they resolve to `{}`).

- [ ] **Step 4: Wire the export**

In `packages/engine/src/index.ts`, add after the existing exports:
```ts
export * from "./entitlements";
```
In `packages/engine/package.json` `"exports"`, add the subpath (so `@perps/engine/entitlements` resolves for any subpath consumer):
```json
    "./entitlements": "./src/entitlements.ts",
```

- [ ] **Step 5: Run tests to green**

Run: `cd packages/engine && npx vitest run src/entitlements.test.ts`
Expected: PASS (all cases).
Run: `cd packages/engine && npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/entitlements.ts packages/engine/src/entitlements.test.ts packages/engine/src/index.ts packages/engine/package.json
git commit -m "feat(engine): shared perk-entitlement envelope module"
```

---

## Task 3: `upgrade_levels` table + ledger time index

**Files:**
- Modify: `server/src/db/schema.ts`
- Create (generated): `server/drizzle/0014_*.sql`

- [ ] **Step 1: Add the table + index to `schema.ts`**

Append to `server/src/db/schema.ts` (mirrors the counted `inventory` table's style; one row per user):

```ts
/** Authoritative per-user upgrade levels (Turbo/Tank/Suspension). Client localStorage is a mirror;
 *  the server wins on sign-in. Levels feed the entitlement envelope, so they MUST be authoritative. */
export const upgradeLevels = pgTable("upgrade_levels", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  turbo: integer("turbo").notNull().default(0),
  tank: integer("tank").notNull().default(0),
  suspension: integer("suspension").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type UpgradeLevelsRow = typeof upgradeLevels.$inferSelect;
```

In the `ledgerEntries` table definition, add a `(user_id, created_at)` index inside its index callback (the earn-rate cap does a time-windowed sum; there is no `created_at` index today):

```ts
    userCreatedIdx: index("ledger_user_created_idx").on(t.userId, t.createdAt),
```

- [ ] **Step 2: Generate the migration**

Run: `cd server && npm run db:generate`
Expected: a new `server/drizzle/0014_*.sql` creating `upgrade_levels` and the `ledger_user_created_idx` index, plus an updated `server/drizzle/meta/` snapshot.

- [ ] **Step 3: Confirm it type-checks + tests still pass against pglite**

Run: `cd server && npm run build`
Expected: exit 0.
Run: `cd server && npx vitest run src/test/harness.test.ts 2>/dev/null || cd server && npx vitest run --dir src 2>&1 | tail -5`
Expected: the in-memory pglite harness applies the new migration cleanly (no failures introduced).

- [ ] **Step 4: Commit**

```bash
git add server/src/db/schema.ts server/drizzle/
git commit -m "feat(server): upgrade_levels table + ledger time index"
```

---

## Task 4: Authoritative upgrades service (get/list/buy)

**Files:**
- Create: `server/src/services/upgrades.ts`
- Create: `server/src/services/upgrades.test.ts`

**Design:** `buy(userId, track)` is the authoritative purchase — it debits coins by `upgradeCost(currentLevel)` and increments the level in ONE transaction, so a client can neither fake a level nor get one for free. `upgradeCost` and `MAX_UPGRADE_LEVEL` come from the shared module (single source).

- [ ] **Step 1: Export `upgradeCost` from the shared module**

The client's `upgradeCost` (`upgrades.ts:8` → `20 * (level + 1)`) must be shared. Add to `packages/engine/src/entitlements.ts`:
```ts
/** coins to go from `level` → `level+1` (escalating). Mirrors redline3d upgrades.ts. */
export const upgradeCost = (level: number): number => 20 * (level + 1);
export type UpgradeTrack = "turbo" | "tank" | "suspension";
```
Re-run `cd packages/engine && npx vitest run src/entitlements.test.ts` to confirm still green, then continue.

- [ ] **Step 2: Write the failing test**

Create `server/src/services/upgrades.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../test/harness"; // VERIFY this helper name/path in src/test/harness.ts
import { makeLedger } from "./ledger";
import { makeUpgrades } from "./upgrades";

describe("upgrades service", () => {
  let db: any, ledger: any, upgrades: any, userId: string;
  beforeEach(async () => {
    ({ db, userId } = await makeTestDb()); // VERIFY harness returns a seeded user id; else create one
    ledger = makeLedger(db);
    upgrades = makeUpgrades(db, ledger);
    await ledger.credit(userId, "coin", 1000, "dev_grant", `seed:${userId}`);
  });

  it("defaults to all-zero levels for a fresh user", async () => {
    expect(await upgrades.get(userId)).toEqual({ turbo: 0, tank: 0, suspension: 0 });
  });

  it("buy debits the escalating cost and increments the level", async () => {
    const r = await upgrades.buy(userId, "turbo"); // cost at level 0 = 20*(0+1) = 20
    expect(r).toEqual({ track: "turbo", level: 1, coins: 980 });
    expect((await upgrades.get(userId)).turbo).toBe(1);
  });

  it("rejects when coins can't cover the cost (no level change)", async () => {
    await ledger.debit(userId, "coin", 1000, "spend", `drain:${userId}`); // balance 0
    await expect(upgrades.buy(userId, "turbo")).rejects.toThrow("insufficient balance");
    expect((await upgrades.get(userId)).turbo).toBe(0);
  });

  it("rejects buying past MAX_UPGRADE_LEVEL", async () => {
    // fast-forward turbo to 10 via direct sets is not exposed; buy 10 times with enough coins
    await ledger.credit(userId, "coin", 100000, "dev_grant", `topup:${userId}`);
    for (let i = 0; i < 10; i++) await upgrades.buy(userId, "turbo");
    await expect(upgrades.buy(userId, "turbo")).rejects.toThrow("max_level");
  });

  it("seed sets levels directly (migration path), idempotent-safe", async () => {
    await upgrades.seed(userId, { turbo: 3, tank: 2, suspension: 1 });
    expect(await upgrades.get(userId)).toEqual({ turbo: 3, tank: 2, suspension: 1 });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd server && npx vitest run src/services/upgrades.test.ts`
Expected: FAIL — cannot find module `./upgrades`.
(If `makeTestDb`/harness names differ, fix the import to match `server/src/test/harness.ts` before proceeding — do not invent helpers.)

- [ ] **Step 4: Implement `upgrades.ts`**

Create `server/src/services/upgrades.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { upgradeLevels } from "../db/schema.js";
import { upgradeCost, MAX_UPGRADE_LEVEL, type UpgradeTrack } from "@perps/engine";
import type { Ledger } from "./ledger.js";

export interface Levels { turbo: number; tank: number; suspension: number; }
const ZERO: Levels = { turbo: 0, tank: 0, suspension: 0 };
const TRACKS: UpgradeTrack[] = ["turbo", "tank", "suspension"];

export function makeUpgrades(db: any, ledger: Ledger) {
  async function get(userId: string): Promise<Levels> {
    const rows = await db.select().from(upgradeLevels).where(eq(upgradeLevels.userId, userId)).limit(1);
    if (!rows.length) return { ...ZERO };
    const r = rows[0];
    return { turbo: r.turbo, tank: r.tank, suspension: r.suspension };
  }

  return {
    get,

    /** Authoritative purchase: debit escalating cost + increment level atomically. Level and cost
     *  come from the server's own record, so the client cannot fake a level or skip the coin cost. */
    async buy(userId: string, track: UpgradeTrack): Promise<{ track: UpgradeTrack; level: number; coins: number }> {
      if (!TRACKS.includes(track)) throw new Error("bad_track");
      return db.transaction(async (tx: any) => {
        // lock this user's row (or create it), read the current level under the tx
        await tx.insert(upgradeLevels).values({ userId }).onConflictDoNothing();
        const rows = await tx.select().from(upgradeLevels).where(eq(upgradeLevels.userId, userId)).limit(1).for("update");
        const cur = rows[0][track] as number;
        if (cur >= MAX_UPGRADE_LEVEL) throw new Error("max_level");
        const cost = upgradeCost(cur);
        const ok = await ledger.debitOn(tx, userId, "coin", cost, "upgrade_buy", `upgrade:${userId}:${track}:${cur}`);
        // debitOn throws "insufficient balance" on overdraw; `ok===false` only on idempotent replay
        await tx.update(upgradeLevels).set({ [track]: cur + 1, updatedAt: new Date() }).where(eq(upgradeLevels.userId, userId));
        const coins = await ledger.balanceOn(tx, userId, "coin");
        return { track, level: cur + 1, coins };
      });
    },

    /** Migration seed: set levels directly (used once when a signed-in account is server-empty and
     *  the client offers its local levels). Never debits — the coins were already spent client-side. */
    async seed(userId: string, levels: Partial<Levels>): Promise<Levels> {
      const clamp = (n: unknown) => Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(Number(n) || 0)));
      const next = { turbo: clamp(levels.turbo), tank: clamp(levels.tank), suspension: clamp(levels.suspension) };
      await db.insert(upgradeLevels).values({ userId, ...next })
        .onConflictDoUpdate({ target: upgradeLevels.userId, set: { ...next, updatedAt: new Date() } });
      return next;
    },
  };
}
export type Upgrades = ReturnType<typeof makeUpgrades>;
```

- [ ] **Step 5: Run tests to green**

Run: `cd server && npx vitest run src/services/upgrades.test.ts`
Expected: PASS. If `.for("update")` is unsupported on pglite, replace with the same `pg_advisory_xact_lock(hashtextextended(userId,0))` pattern `ledger.ts:33` uses (quote it) and re-run.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/upgrades.ts server/src/services/upgrades.test.ts packages/engine/src/entitlements.ts
git commit -m "feat(server): authoritative upgrade levels (buy/seed/get)"
```

---

## Task 5: Rolling earn-rate cap

**Files:**
- Create: `server/src/services/earn-limit.ts`
- Create: `server/src/services/earn-limit.test.ts`

**Design:** coarse defense-in-depth (per the spec's "source-of-truth ledger + bounds"). Before crediting an `earn`/`scrap_earn`, sum that reason's credits for the user over the last `windowMs` and reject if `sum + amount > ceiling`. Ceiling/window are env-tunable with generous documented defaults (they must sit ABOVE the fastest legit run — tune from real gameplay, do not guess tight).

- [ ] **Step 1: Write the failing test**

Create `server/src/services/earn-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../test/harness";
import { makeLedger } from "./ledger";
import { makeEarnLimit } from "./earn-limit";

describe("earn-limit", () => {
  let db: any, ledger: any, limit: any, userId: string;
  beforeEach(async () => {
    ({ db, userId } = await makeTestDb());
    ledger = makeLedger(db);
    limit = makeEarnLimit(db, { ceiling: 100, windowMs: 60_000 });
  });

  it("allows an earn under the window ceiling", async () => {
    expect(await limit.check(userId, "earn", 60)).toBe(true);
  });

  it("rejects an earn that would exceed the ceiling within the window", async () => {
    await ledger.credit(userId, "coin", 80, "earn", `${userId}:a`);
    expect(await limit.check(userId, "earn", 30)).toBe(false); // 80 + 30 > 100
  });

  it("windows are per-reason (scrap_earn independent of earn)", async () => {
    await ledger.credit(userId, "coin", 100, "earn", `${userId}:full`);
    expect(await limit.check(userId, "scrap_earn", 50)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/services/earn-limit.test.ts`
Expected: FAIL — cannot find module `./earn-limit`.

- [ ] **Step 3: Implement `earn-limit.ts`**

Create `server/src/services/earn-limit.ts`:

```ts
import { and, eq, gte, sql } from "drizzle-orm";
import { ledgerEntries } from "../db/schema.js";

export interface EarnLimitCfg { ceiling: number; windowMs: number; }

/** Coarse anti-abuse: caps how much a user can EARN (client-reported pickups) per rolling window.
 *  Not a full economy model — just refuses implausible bursts. Server-authoritative credits (round
 *  payouts, crate purchases) use different reasons and are unaffected. */
export function makeEarnLimit(db: any, cfg: EarnLimitCfg) {
  return {
    /** true if crediting `amount` under `reason` stays within the window ceiling. */
    async check(userId: string, reason: "earn" | "scrap_earn", amount: number): Promise<boolean> {
      const since = new Date(Date.now() - cfg.windowMs);
      const rows = await db
        .select({ sum: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` })
        .from(ledgerEntries)
        .where(and(
          eq(ledgerEntries.userId, userId),
          eq(ledgerEntries.reason, reason),
          gte(ledgerEntries.createdAt, since),
        ));
      const windowSum = Number(rows[0]?.sum ?? 0);
      return windowSum + amount <= cfg.ceiling;
    },
  };
}
export type EarnLimit = ReturnType<typeof makeEarnLimit>;
```

- [ ] **Step 4: Run tests to green**

Run: `cd server && npx vitest run src/services/earn-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/earn-limit.ts server/src/services/earn-limit.test.ts
git commit -m "feat(server): rolling earn-rate cap helper"
```

---

## Task 6: `entitlementsFor` oracle

**Files:**
- Create: `server/src/services/entitlements.ts`
- Create: `server/src/services/entitlements.test.ts`

**Design:** `entitlementsFor(userId, carId)` = the perk envelope the player is allowed with a specific owned car. It verifies ownership, reads authoritative levels, and calls the shared `perkEnvelope`. This is the exact function Phase 2's `/authorize` validates the requested open against.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/entitlements.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../test/harness";
import { makeLedger } from "./ledger";
import { makeInventory } from "./inventory";
import { makeUpgrades } from "./upgrades";
import { makeEntitlements } from "./entitlements";

describe("entitlementsFor", () => {
  let db: any, svc: any, userId: string, ledger: any, upgrades: any, inventory: any;
  beforeEach(async () => {
    ({ db, userId } = await makeTestDb());
    ledger = makeLedger(db); inventory = makeInventory(db); upgrades = makeUpgrades(db, ledger);
    svc = makeEntitlements({ inventory, upgrades });
  });

  it("rejects a car the user does not own", async () => {
    await expect(svc.entitlementsFor(userId, "orion")).rejects.toThrow("car_not_owned");
  });

  it("returns the envelope for an owned car at the user's levels", async () => {
    await inventory.grant(userId, "orion"); // VERIFY 'orion' matches CAR_PERKS key from Task 2 Step 3a
    await ledger.credit(userId, "coin", 100000, "dev_grant", `seed:${userId}`);
    for (let i = 0; i < 10; i++) await upgrades.buy(userId, "turbo");
    const e = await svc.entitlementsFor(userId, "orion");
    expect(e.maxLev).toBe(3000); // nitro at maxed turbo: 1500 * 2
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/services/entitlements.test.ts`
Expected: FAIL — cannot find module `./entitlements`.

- [ ] **Step 3: Implement `entitlements.ts`**

Create `server/src/services/entitlements.ts`:

```ts
import { perkEnvelope, carPerk, type PerkEnvelope } from "@perps/engine";
import type { Inventory } from "./inventory.js";
import type { Upgrades } from "./upgrades.js";

export function makeEntitlements(deps: { inventory: Inventory; upgrades: Upgrades }) {
  return {
    /** The perk envelope the player is entitled to with `carId`. Throws car_not_owned if they don't
     *  hold it. The authority Phase 2's /authorize validates the requested open params against. */
    async entitlementsFor(userId: string, carId: string): Promise<PerkEnvelope> {
      if (!(await deps.inventory.owns(userId, carId))) throw new Error("car_not_owned");
      const levels = await deps.upgrades.get(userId);
      return perkEnvelope(levels, carPerk(carId));
    },
  };
}
export type Entitlements = ReturnType<typeof makeEntitlements>;
```

- [ ] **Step 4: Run tests to green**

Run: `cd server && npx vitest run src/services/entitlements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/entitlements.ts server/src/services/entitlements.test.ts
git commit -m "feat(server): entitlementsFor oracle"
```

---

## Task 7: Wire services into routes (`/me`, `/upgrades/buy`, `/migrate`, earn cap)

**Files:**
- Modify: `server/src/http/routes.ts`, `server/src/http/server.ts`, `server/src/index.ts`, `server/src/env.ts`

- [ ] **Step 1: Construct + inject the services**

In `server/src/index.ts`, after the existing `makeInventory`/`makeLedger` wiring, construct:
```ts
const upgrades = makeUpgrades(db, ledger);
const entitlements = makeEntitlements({ inventory: makeInventory(db), upgrades });
const earnLimit = makeEarnLimit(db, { ceiling: env.EARN_WINDOW_CEILING, windowMs: env.EARN_WINDOW_MS });
```
Add `EARN_WINDOW_CEILING` (default e.g. `5000`) and `EARN_WINDOW_MS` (default `60000`) to `server/src/env.ts` following the existing numeric-env pattern (quote a neighbouring numeric env like `DEPOSIT_POLL_MS` and mirror it). Pass `upgrades`, `entitlements`, `earnLimit` into `buildServer({...})` (extend its `RouteDeps`/params type in `server/src/http/server.ts` to include them, mirroring how `inventory`/`rounds` are threaded).

- [ ] **Step 2: Write failing route tests**

Add to a new `server/src/test/upgrades-routes.test.ts` (follow the harness pattern in `src/test/account-routes.test.ts`, including its `bindDevWallet` helper — economy writes need a wallet-bound session):

```ts
// GET /v1/me now returns `levels`
it("me returns upgrade levels", async () => {
  const { app, userId } = await appWithWalletBoundUser(); // reuse the account-routes harness helper
  const res = await app.inject({ method: "GET", url: "/v1/me", headers: authFor(userId) });
  expect(res.json().levels).toEqual({ turbo: 0, tank: 0, suspension: 0 });
});

// POST /v1/upgrades/buy (wallet-bound) debits + increments
it("upgrades/buy increments the level and debits coins", async () => {
  const { app, userId } = await appWithWalletBoundUser();
  await grantCoins(app, userId, 100);
  const res = await app.inject({ method: "POST", url: "/v1/upgrades/buy", headers: authFor(userId), payload: { track: "turbo" } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ track: "turbo", level: 1 });
});

// anonymous (no wallet) is rejected
it("upgrades/buy rejects an anonymous session", async () => {
  const { app, userId } = await appWithAnonUser();
  const res = await app.inject({ method: "POST", url: "/v1/upgrades/buy", headers: authFor(userId), payload: { track: "turbo" } });
  expect(res.statusCode).toBe(403);
});
```
(Reconcile helper names — `appWithWalletBoundUser`, `authFor`, `grantCoins` — with what `src/test/account-routes.test.ts` and `src/test/harness.ts` actually export; use the real ones.)

- [ ] **Step 3: Run to confirm failure**

Run: `cd server && npx vitest run src/test/upgrades-routes.test.ts`
Expected: FAIL (routes/levels not present yet).

- [ ] **Step 4: Extend `GET /v1/me` to return levels**

In `server/src/http/routes.ts` `GET /v1/me` (lines 187-210), add `deps.upgrades.get(userId)` to the `Promise.all` and include `levels` in the response object:
```ts
    const [balance, coins, scrap, rows, openRoundId, access, levels] = await Promise.all([
      deps.ledger.balance(userId, deps.stakeAsset),
      deps.ledger.balance(userId, "coin"),
      deps.ledger.balance(userId, "scrap"),
      deps.inventory.list(userId),
      deps.rounds.getOpenRoundId(userId),
      deps.users.accessCodes(userId),
      deps.upgrades.get(userId),
    ]);
    return { userId, balance, coins, scrap, cars: rows.map((r) => ({ carId: r.carId, count: r.count, acquiredAt: r.acquiredAt })), openRoundId, access, levels };
```

- [ ] **Step 5: Add `POST /v1/upgrades/buy` (wallet-bound)**

In `server/src/http/routes.ts`, near the other economy routes, add (Zod body + handler mapping service errors to codes):
```ts
  const BuyBody = z.object({ track: z.enum(["turbo", "tank", "suspension"]) });
  server.post("/v1/upgrades/buy", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = BuyBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    try {
      return await deps.upgrades.buy(req.userId!, p.data.track);
    } catch (e: any) {
      if (e?.message === "insufficient balance") return reply.code(402).send({ error: "insufficient_balance" });
      if (e?.message === "max_level") return reply.code(409).send({ error: "max_level" });
      throw e;
    }
  });
```

- [ ] **Step 6: Extend `/v1/migrate` to seed levels**

Extend `MigrateBody` (routes.ts:46-60) with an optional `levels`, and seed it in the handler when the account is empty:
```ts
  levels: z.object({
    turbo: z.number().int().min(0).max(10), tank: z.number().int().min(0).max(10), suspension: z.number().int().min(0).max(10),
  }).partial().optional(),
```
In the migrate handler, after the car grants and inside the `seeded` branch:
```ts
    if (p.data.levels) await deps.upgrades.seed(userId, p.data.levels);
```

- [ ] **Step 7: Wire the earn cap into earn routes**

In `POST /v1/coins/earn` and `POST /v1/scrap/earn`, before crediting, reject over-cap earns AND tighten the per-call max. First lower `CoinDelta`'s `.max(1_000_000_000)` to a sane per-call ceiling (e.g. `.max(100_000)` — document why: a single legit pickup is tiny; 1e9 was a mint hole). Then:
```ts
  server.post("/v1/coins/earn", { preHandler: requireWalletBoundUser }, async (req, reply) => {
    const p = CoinDelta.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "bad_request" });
    if (!(await deps.earnLimit.check(req.userId!, "earn", p.data.amount)))
      return reply.code(429).send({ error: "earn_rate_exceeded" });
    await deps.ledger.credit(req.userId!, "coin", p.data.amount, "earn", `${req.userId!}:${p.data.ref}`);
    return { coins: await deps.ledger.balance(req.userId!, "coin") };
  });
```
Mirror for `/v1/scrap/earn` with reason `"scrap_earn"`.

- [ ] **Step 8: Run all server tests + build**

Run: `cd server && npm run build`
Expected: exit 0.
Run: `cd server && npm test`
Expected: all green (previous baseline + the new route/service tests). Fix any harness-signature mismatches by matching the real helpers.

- [ ] **Step 9: Commit**

```bash
git add server/src
git commit -m "feat(server): me.levels, upgrades/buy, migrate levels, earn cap"
```

---

## Task 8: Client — sync levels through the server

**Files:**
- Modify: `redline3d/src/core/api.ts`, `redline3d/src/core/account-sync.ts`, `redline3d/src/ui/upgrades.ts`

**Design:** the client keeps its local UX; on sign-in it hydrates authoritative levels from the server (server wins), migrates existing local levels up when the account is server-empty, and forwards each purchase to the authoritative `buy`. Guests stay local (forwarders no-op, as today).

- [ ] **Step 1: Extend the API surface**

In `redline3d/src/core/api.ts`: add `levels` to `MeResult`; add `upgradesBuy` and `levels` to `migrate`:
```ts
// MeResult: add
  levels: { turbo: number; tank: number; suspension: number };
// Api interface: add
  upgradesBuy(p: { track: "turbo" | "tank" | "suspension" }): Promise<{ track: string; level: number; coins: number }>;
// migrate signature: add optional levels
  migrate(p: { coins: number; scrap: number; cars: Record<string, number>; levels?: { turbo: number; tank: number; suspension: number } }): Promise<{ seeded: boolean; reason?: string }>;
// bindings block: add
    upgradesBuy: (p) => call("POST", "/v1/upgrades/buy", p),
```

- [ ] **Step 2: Extend account-sync**

In `redline3d/src/core/account-sync.ts`: add `levels` to `AccountSnapshot`; carry it through `hydrate` (seed local levels to server via `migrate({...,levels})`, and write server levels back via `applyServer`); add a `levelBought(track)` forwarder that calls `api.upgradesBuy`. Follow the existing forwarder shape (`coinsSpent`, lines 91-96). The `applyServer` callback payload gains `levels`.

- [ ] **Step 3: Extend upgrades.ts hydrate + purchase**

In `redline3d/src/ui/upgrades.ts`:
- The server-authoritative path: `hydrate` (currently overwrites only `coins`/`scrap`, line ~227) must also accept and apply `levels` when present (server wins), then `apply(); persist(); render();`.
- In `buy()` (lines 189-199), after the local optimistic increment, forward to the server via the new `onMutate`/sync hook: add a `levelBought` callback to the upgrades options and call it (`opts.onMutate?.({ kind: "levelBought", track: key })` — extend the `onMutate` union), wired in `main.ts` to `accountSync.levelBought(track)`. Keep the local increment optimistic (server-wins reconciles on next hydrate); on a server rejection the next hydrate corrects it.

- [ ] **Step 4: Type-check + build + test**

Run: `cd redline3d && npm run build`
Expected: exit 0 (tsc + vite).
Run: `cd redline3d && npm test`
Expected: all green. Add/adjust a unit test for the account-sync levels path mirroring the existing account-sync tests.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src
git commit -m "feat(client): sync upgrade levels through the server (server wins)"
```

---

## Task 9: Parity guard — shared module vs client's live formulas

**Files:**
- Create: `redline3d/src/core/entitlements-parity.test.ts`

**Design:** until Phase 2 refactors the client to *consume* the shared module, a test asserts the shared `perkEnvelope` still matches what the client's `effRmax`/`effMaxSec`/`CONFIG.LIQ` path would produce for representative (levels, car) combos — so drift is caught immediately.

- [ ] **Step 1: Write the parity test**

Create `redline3d/src/core/entitlements-parity.test.ts` asserting, for a grid of levels × the perk-bearing cars, that `perkEnvelope(...)` from `@perps/engine` equals the client's own computation (`trackValue`-based RMAX/MAXSEC/LIQ and the ability perks from `main.ts`). Import the client constants directly so a change to either side breaks the test.

```ts
import { describe, it, expect } from "vitest";
import { perkEnvelope, carPerk } from "@perps/engine";
import { trackValue } from "../ui/upgrades"; // exported helper
import { CONFIG } from "./config";

// Recompute the envelope the way the client does today and assert equality for a few cases.
describe("entitlement parity (client vs shared)", () => {
  it("maxed turbo → maxLev matches trackValue(RMAX base, 50, 10)", () => {
    const shared = perkEnvelope({ turbo: 10, tank: 0, suspension: 0 }, {});
    expect(shared.maxLev).toBe(Math.round(trackValue(1000, 50, 10))); // 1500
  });
  // add tank, suspension, sixWheeler, nitro, cybertruck baseLev cases likewise
});
```

- [ ] **Step 2: Run + green**

Run: `cd redline3d && npx vitest run src/core/entitlements-parity.test.ts`
Expected: PASS. Any mismatch means the shared module and client drifted — fix the shared module to match the client's *current* live behavior (the client is the behavioral baseline for Phase 1).

- [ ] **Step 3: Commit**

```bash
git add redline3d/src/core/entitlements-parity.test.ts
git commit -m "test(client): parity guard for the shared entitlement module"
```

---

## Final verification

- [ ] `cd packages/engine && npm run build && npx vitest run` → green
- [ ] `cd server && npm run build && npm test` → green (baseline + new)
- [ ] `cd redline3d && npm run build && npm test` → green (baseline + new)
- [ ] Manually confirm the migration applies: `cd server && npm run db:generate` shows no pending diff (the 0014 migration already captures the schema).

## What Phase 2 picks up (not in this plan)
- On-chain `entitlement_authority` on `HouseBalance` + required `Signer` on `open` (de-risk ER multi-signer first; Ed25519-permit fallback).
- `POST /v1/round/authorize` that calls `entitlementsFor`, validates the requested open params ≤ envelope, and co-signs.
- Client open flow calls `/authorize` and refactors to build its request FROM the shared module (retiring the parity test in Task 9).
- Deploy ripples: regen client IDL, `initHouse` arg, devnet redeploy + house re-init.
