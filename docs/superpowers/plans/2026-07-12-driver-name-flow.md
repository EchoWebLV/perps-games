# Driver Name Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every player an editable driver name, persist signed-in names to Railway, and require account-name confirmation before local Highway entry.

**Architecture:** Guests keep their chosen name in the existing local identity. Signed-in accounts gain nullable `users.driver_name`; `/v1/me` hydrates it and a profile endpoint updates it. A focused name dialog is shared by Settings and the Highway guard, while presence continues reading `identity.name`.

**Tech Stack:** TypeScript, Fastify, Zod, Drizzle/Postgres, Vite DOM UI, Vitest, Railway CLI

## Global Constraints

- Normalize names with trim plus lowercase and accept only `^[a-z0-9_]{3,16}$`.
- Driver names are display labels and are not unique.
- Railway is authoritative for signed-in account names; guest names remain local.
- Public-host Highway stays `Coming soon` and must not open the name dialog.
- A failed signed-in save does not mutate local identity and does not enter Highway.
- Do not change wallet binding, financial authorization, presence protocol, or other buildings.

---

## File structure

- `server/drizzle/0016_driver_name.sql`: nullable account profile column.
- `server/src/db/schema.ts`: Drizzle `driverName` field.
- `server/src/services/users.ts`: account-scoped read/write operations.
- `server/src/test/users.test.ts`: service behavior.
- `server/src/http/routes.ts`: profile endpoint and `/v1/me` response.
- `server/src/test/account-routes.test.ts`: route behavior and authorization.
- `redline3d/src/core/api.ts`: client contract for profile reads/writes.
- `redline3d/src/core/api.test.ts`: request mapping.
- `redline3d/src/core/account-sync.ts`: expose hydrated profile name.
- `redline3d/src/core/account-sync.test.ts`: hydration behavior.
- `redline3d/src/ui/driver-name.ts`: single-purpose dialog.
- `redline3d/src/ui/driver-name.test.ts`: DOM interaction and failures.
- `redline3d/src/ui/carpicker.ts`: Settings row and callback seam.
- `redline3d/src/ui/carpicker.test.ts`: menu integration.
- `redline3d/src/core/highway-access.ts`: pure entry decision.
- `redline3d/src/core/highway-access.test.ts`: public/name guard decisions.
- `redline3d/src/main.ts`: state hydration, dialog orchestration, menu callback, and Highway entry.
- `redline3d/src/core/identity.test.ts`: source-level integration guard for main wiring.

---

### Task 1: Railway account profile storage

**Files:**
- Create: `server/drizzle/0016_driver_name.sql`
- Modify: `server/drizzle/meta/_journal.json`
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/services/users.ts`
- Test: `server/src/test/users.test.ts`

**Interfaces:**
- Produces: `users.driverName: string | null`
- Produces: `usersService.driverName(id): Promise<string | null>`
- Produces: `usersService.setDriverName(id, name): Promise<string>`

- [ ] **Step 1: Write failing service tests**

Add tests proving a fresh account returns `null`, a valid mixed-case input is stored as normalized lowercase, repeated updates replace the value, invalid inputs reject, and two accounts remain isolated.

```ts
it("stores a normalized driver name and allows later renames", async () => {
  const user = await ctx.users.upsertByExternalId("dev:named");
  expect(await ctx.users.driverName(user.id)).toBeNull();
  expect(await ctx.users.setDriverName(user.id, "  Liq_Dodger ")).toBe("liq_dodger");
  expect(await ctx.users.setDriverName(user.id, "new_driver")).toBe("new_driver");
  expect(await ctx.users.driverName(user.id)).toBe("new_driver");
});

it.each(["", "ab", "spaces fail", "way_too_long_driver_name"])("rejects invalid driver name %j", async (name) => {
  const user = await ctx.users.upsertByExternalId("dev:invalid");
  await expect(ctx.users.setDriverName(user.id, name)).rejects.toThrow("invalid_driver_name");
});
```

- [ ] **Step 2: Run the service tests and verify RED**

Run: `npm test --workspace @perps/server -- src/test/users.test.ts --fileParallelism=false`

Expected: FAIL because `driverName` and `setDriverName` do not exist.

- [ ] **Step 3: Add the migration, schema field, and service methods**

Migration:

```sql
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "driver_name" text;
```

Schema field:

```ts
driverName: text("driver_name"),
```

Service normalization and methods:

```ts
function normalizeDriverName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return /^[a-z0-9_]{3,16}$/.test(name) ? name : null;
}

async driverName(id: string): Promise<string | null> {
  const rows = await db.select({ driverName: users.driverName }).from(users).where(eq(users.id, id)).limit(1);
  return rows[0]?.driverName ?? null;
}
async setDriverName(id: string, raw: string): Promise<string> {
  const name = normalizeDriverName(raw);
  if (!name) throw new Error("invalid_driver_name");
  const rows = await db.update(users).set({ driverName: name }).where(eq(users.id, id)).returning({ driverName: users.driverName });
  if (!rows[0]?.driverName) throw new Error("user_not_found");
  return rows[0].driverName;
}
```

Append journal entry index `16`, tag `0016_driver_name`, version `7`, with a current millisecond timestamp.

- [ ] **Step 4: Run service tests and verify GREEN**

Run: `npm test --workspace @perps/server -- src/test/users.test.ts --fileParallelism=false`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle/0016_driver_name.sql server/drizzle/meta/_journal.json server/src/db/schema.ts server/src/services/users.ts server/src/test/users.test.ts
git commit -m "feat: persist account driver names"
```

---

### Task 2: Profile HTTP and client API

**Files:**
- Modify: `server/src/http/routes.ts`
- Test: `server/src/test/account-routes.test.ts`
- Modify: `redline3d/src/core/api.ts`
- Test: `redline3d/src/core/api.test.ts`

**Interfaces:**
- Produces: `GET /v1/me -> { ..., driverName: string | null }`
- Produces: `POST /v1/profile/driver-name { name } -> { driverName }`
- Produces: `Api.setDriverName(name: string): Promise<{ driverName: string }>`

- [ ] **Step 1: Write failing route tests**

```ts
it("returns null then the saved normalized driver name from /v1/me", async () => {
  ctx = await makeTestDb({ signupFaucet: false });
  expect((await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H })).json().driverName).toBeNull();
  const save = await ctx.server.inject({ method: "POST", url: "/v1/profile/driver-name", headers: H, payload: { name: "  Road_King " } });
  expect(save.json()).toEqual({ driverName: "road_king" });
  expect((await ctx.server.inject({ method: "GET", url: "/v1/me", headers: H })).json().driverName).toBe("road_king");
});

it("rejects invalid and anonymous driver-name writes", async () => {
  ctx = await makeTestDb({ signupFaucet: false });
  const invalid = await ctx.server.inject({ method: "POST", url: "/v1/profile/driver-name", headers: H, payload: { name: "no spaces" } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: "invalid_driver_name" });
  const anonymous = await ctx.server.inject({ method: "POST", url: "/v1/profile/driver-name", payload: { name: "road_king" } });
  expect(anonymous.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test --workspace @perps/server -- src/test/account-routes.test.ts --fileParallelism=false`

Expected: FAIL with 404 for the profile endpoint and missing `driverName`.

- [ ] **Step 3: Implement the server route**

Add `const DriverNameBody = z.object({ name: z.string() })`, call `deps.users.setDriverName`, translate `invalid_driver_name` to HTTP 400 `{ error: "invalid_driver_name" }`, and include `driverName` in the `/v1/me` Promise.all/result.

- [ ] **Step 4: Run route tests and verify GREEN**

Run: `npm test --workspace @perps/server -- src/test/account-routes.test.ts --fileParallelism=false`

Expected: PASS.

- [ ] **Step 5: Write a failing client API test**

Assert `api.setDriverName("road_king")` sends `POST /v1/profile/driver-name` with `{ name: "road_king" }` and returns `{ driverName: "road_king" }`.

- [ ] **Step 6: Run client API test and verify RED**

Run: `npm test --prefix redline3d -- src/core/api.test.ts --fileParallelism=false`

Expected: FAIL because `setDriverName` does not exist.

- [ ] **Step 7: Extend the client types and method**

```ts
export interface MeResult {
  userId: string;
  balance: number;
  coins: number;
  scrap: number;
  cars: { carId: string; count: number; acquiredAt?: string }[];
  openRoundId: string | null;
  access: string[];
  levels?: { turbo: number; tank: number; suspension: number };
  driverName: string | null;
}
// Api
setDriverName(name: string): Promise<{ driverName: string }>;
// implementation
setDriverName: (name) => call("POST", "/v1/profile/driver-name", { name }),
```

- [ ] **Step 8: Run client API test and verify GREEN**

Run: `npm test --prefix redline3d -- src/core/api.test.ts --fileParallelism=false`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/http/routes.ts server/src/test/account-routes.test.ts redline3d/src/core/api.ts redline3d/src/core/api.test.ts
git commit -m "feat: expose driver name profile API"
```

---

### Task 3: Hydrated account-name state

**Files:**
- Modify: `redline3d/src/core/account-sync.ts`
- Test: `redline3d/src/core/account-sync.test.ts`

**Interfaces:**
- Produces: `AccountSync.driverName(): string | null`
- During `hydrate`, captures `me.driverName ?? null` on both seeded and server-wins paths.

- [ ] **Step 1: Write the failing hydration test**

```ts
it("surfaces the Railway driver name after hydrate and clears it on disable", async () => {
  const api = fakeApi({ me: vi.fn(async () => ({
    userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null,
    access: [], driverName: "road_king",
  })) });
  const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
  expect(sync.driverName()).toBeNull();
  await sync.hydrate(empty);
  expect(sync.driverName()).toBe("road_king");
  sync.disable();
  expect(sync.driverName()).toBeNull();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test --prefix redline3d -- src/core/account-sync.test.ts --fileParallelism=false`

Expected: FAIL because `driverName` does not exist.

- [ ] **Step 3: Implement the state accessor**

Add `let driverName: string | null = null`, expose `driverName: () => driverName`, assign from `me.driverName ?? null`, and clear it in `disable()`.

- [ ] **Step 4: Run and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/core/account-sync.ts redline3d/src/core/account-sync.test.ts
git commit -m "feat: hydrate account driver names"
```

---

### Task 4: Focused Driver Name dialog

**Files:**
- Create: `redline3d/src/ui/driver-name.ts`
- Create: `redline3d/src/ui/driver-name.test.ts`

**Interfaces:**
- Consumes: `validateName(raw): string | null` from `ui/identity.ts`
- Produces: `createDriverNameDialog(parent, { currentName, requiredForHighway, onSave, onCancel })`

- [ ] **Step 1: Write failing DOM tests**

Cover current-name prefill, invalid-name inline error, normalized Save callback, Cancel, Enter-to-save, disabled busy state, and rejected async save preserving the open dialog with `Couldn't save your driver name. Try again.`

- [ ] **Step 2: Run and verify RED**

Run: `npm test --prefix redline3d -- src/ui/driver-name.test.ts --fileParallelism=false`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal dialog**

Build a fixed `z-index:31` panel containing heading `DRIVER NAME`, an input with accessible label/placeholder, inline status, Cancel, and Save. Suppress input key events from global driving controls. Only remove the dialog after `onSave(normalizedName)` resolves.

- [ ] **Step 4: Run and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/driver-name.ts redline3d/src/ui/driver-name.test.ts
git commit -m "feat: add driver name dialog"
```

---

### Task 5: Settings row

**Files:**
- Modify: `redline3d/src/ui/carpicker.ts`
- Test: `redline3d/src/ui/carpicker.test.ts`

**Interfaces:**
- Extend `MenuFeatures` with `driverName?: { current(): string | null; edit(): void }`.
- Render account-section row `Driver Name`, subtitle current value or `choose your name`.

- [ ] **Step 1: Write a failing menu test**

Create the picker with `driverName`, open the menu, assert the row/subtitle, click it, and expect `edit` once. Change the getter value, reopen, and assert refresh.

- [ ] **Step 2: Run and verify RED**

Run: `npm test --prefix redline3d -- src/ui/carpicker.test.ts --fileParallelism=false`

Expected: FAIL because no Driver Name row exists.

- [ ] **Step 3: Implement the row and event dispatch**

Append the row above Sign in/Log out, refresh `[data-driver-name]` in `refreshMenu`, and handle `data-act="driver-name"` by closing with `chain` then calling `menuFeatures.driverName?.edit()`.

- [ ] **Step 4: Run and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add redline3d/src/ui/carpicker.ts redline3d/src/ui/carpicker.test.ts
git commit -m "feat: add Driver Name to settings"
```

---

### Task 6: Highway guard and application wiring

**Files:**
- Modify: `redline3d/src/core/highway-access.ts`
- Test: `redline3d/src/core/highway-access.test.ts`
- Modify: `redline3d/src/main.ts`
- Test: `redline3d/src/core/identity.test.ts`

**Interfaces:**
- Produces: `highwayEntryDecision(hostname, confirmed): "coming-soon" | "driver-name" | "enter"`.
- Main owns `openDriverNameDialog(afterSave?)` and updates `identity`, localStorage, Railway, and presence in the correct order.

- [ ] **Step 1: Write the failing pure guard tests**

```ts
expect(highwayEntryDecision("redline-web-production.up.railway.app", false)).toBe("coming-soon");
expect(highwayEntryDecision("localhost", false)).toBe("driver-name");
expect(highwayEntryDecision("localhost", true)).toBe("enter");
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test --prefix redline3d -- src/core/highway-access.test.ts --fileParallelism=false`

Expected: FAIL because `highwayEntryDecision` does not exist.

- [ ] **Step 3: Implement the pure decision**

Use existing `highwayAvailable` first, then return `driver-name` for unconfirmed local entry and `enter` otherwise.

- [ ] **Step 4: Run and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Write source-level integration assertions before main wiring**

Assert main imports the dialog and decision helper, supplies a `driverName` menu feature, hydrates `accountSync.driverName()`, calls `api.setDriverName`, reconnects presence after success, and routes the Highway branch through the three decisions.

- [ ] **Step 6: Run integration test and verify RED**

Run: `npm test --prefix redline3d -- src/core/identity.test.ts --fileParallelism=false`

Expected: FAIL on the missing wiring strings.

- [ ] **Step 7: Wire main**

Implement one dialog orchestration helper. Guest saves mutate local identity directly. Signed-in saves await `api.setDriverName` before mutating. After `syncAccount`, replace the cached identity name when `accountSync.driverName()` is non-null, save it, and reconnect presence. Pass the Settings callbacks into `createCarPicker`. Replace the Highway branch with the pure decision and automatically enter after a required successful save.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
npm test --prefix redline3d -- src/core/highway-access.test.ts src/core/identity.test.ts src/ui/driver-name.test.ts src/ui/carpicker.test.ts --fileParallelism=false
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add redline3d/src/core/highway-access.ts redline3d/src/core/highway-access.test.ts redline3d/src/main.ts redline3d/src/core/identity.test.ts
git commit -m "feat: require a driver name for Highway"
```

---

### Task 7: Full verification and Railway deployment

**Files:**
- No additional product files expected.

- [ ] **Step 1: Run full server verification**

Run: `npm test --workspace @perps/server && npm run build --workspace @perps/server`

Expected: all tests pass and TypeScript build succeeds.

- [ ] **Step 2: Run full client verification**

Run: `npm test --prefix redline3d -- --fileParallelism=false && npm run build --prefix redline3d -- --logLevel error`

Expected: all tests pass and Vite build succeeds; existing dependency warnings may remain.

- [ ] **Step 3: Deploy Railway server first**

Run: `railway up --service redline-server --environment production --ci --message "Persist driver names"`

Expected: migration `0016_driver_name` applies and server health remains successful.

- [ ] **Step 4: Deploy Railway web from the clean monorepo snapshot**

Use the established web-only snapshot flow so `redline3d` and `packages/engine` are present while the server `railway.toml` is absent. Deploy to `redline-web`, never Postgres directly.

- [ ] **Step 5: Verify production**

Confirm both service deployments are `SUCCESS`, `/healthz` returns 200, the public site returns 200, `/v1/me` contains `driverName`, and the deployed web bundle contains `Driver Name` plus `Highway coming soon`.

- [ ] **Step 6: Final branch state**

Confirm only unrelated pre-existing files remain dirty, report commit IDs and deployment IDs, and preserve the feature branch for user-selected integration.
