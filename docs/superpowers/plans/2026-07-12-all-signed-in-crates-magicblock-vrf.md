# All Signed-In Crates Use MagicBlock VRF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require MagicBlock VRF for every signed-in crate, including the welcome crate, while leaving an unfunded or failed welcome claim pending and allowing guest practice crates to use client RNG.

**Architecture:** Railway exposes a read-only welcome status while retaining the existing atomic claim as the final one-winner gate. The client checks status before offering the gift, requests VRF before claiming, and reveals or mutates rewards only after the atomic claim succeeds. Crate randomness selection becomes an explicit `vrf`, `client`, or `blocked` policy so a signed-in path can never silently fall back.

**Tech Stack:** TypeScript, Vite, Vitest, Fastify, Drizzle ORM, PostgreSQL/PGlite, Anchor client, MagicBlock VRF

## Global Constraints

- Guest practice crates remain the only client-RNG path.
- Every signed-in free or paid crate must use the existing MagicBlock `crate_roll` VRF provider.
- Signed-in crates fail closed when the wallet, RPC, or oracle is unavailable.
- Do not sponsor transaction fees or add a database migration.
- Do not move crate odds, inventory, or reward computation into the on-chain program in this change.
- Do not consume the welcome claim until VRF randomness has succeeded.
- Do not use em dash characters in new copy or comments.
- Preserve unrelated user files and the existing untracked `artifacts/` directory.

## File Map

- `server/src/services/users.ts`: read-only welcome pending state and existing atomic claim mutation.
- `server/src/http/routes.ts`: wallet-bound `GET /v1/welcome/status` and existing `POST /v1/welcome/claim`.
- `server/src/test/users.test.ts`: service-level status and non-mutation coverage.
- `server/src/test/account-routes.test.ts`: endpoint auth, pending, claimed, and non-consuming behavior.
- `redline3d/src/core/api.ts`: typed client method for welcome status.
- `redline3d/src/core/api.test.ts`: request method/path coverage for status versus claim.
- `redline3d/src/core/round-sync.test.ts`: update the complete `Api` test double with the new method.
- `redline3d/src/ui/cratebox.ts`: explicit randomness policy, fail-closed behavior, and post-VRF welcome completion gate.
- `redline3d/src/ui/cratebox.test.ts`: policy and reward-order regression tests.
- `redline3d/src/core/welcome.ts`: small async coordinator that offers a gift only when status is pending.
- `redline3d/src/core/welcome.test.ts`: pending-status coordinator tests.
- `redline3d/src/main.ts`: wire account identity, status, VRF, and atomic completion into the UI.

---

### Task 1: Add a non-consuming Railway welcome status

**Files:**
- Modify: `server/src/services/users.ts`
- Modify: `server/src/http/routes.ts`
- Test: `server/src/test/users.test.ts`
- Test: `server/src/test/account-routes.test.ts`

**Interfaces:**
- Produces: `Users.welcomeStatus(id: string): Promise<{ pending: boolean }>`
- Produces: `GET /v1/welcome/status -> { pending: boolean }`
- Preserves: `Users.claimWelcome(id)` and `POST /v1/welcome/claim` as the atomic false-to-true gate

- [ ] **Step 1: Write failing service tests for pending state without consumption**

Add to the `users service` suite in `server/src/test/users.test.ts`:

```ts
it("reports welcome pending without consuming the claim", async () => {
  const user = await ctx.users.upsertByExternalId("dev:pending");

  expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: true });
  expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: true });
  expect(await ctx.users.claimWelcome(user.id)).toEqual({ granted: true });
  expect(await ctx.users.welcomeStatus(user.id)).toEqual({ pending: false });
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
npm --prefix server test -- src/test/users.test.ts
```

Expected: FAIL because `ctx.users.welcomeStatus` does not exist.

- [ ] **Step 3: Implement the read-only service method**

Add immediately before `claimWelcome` in `server/src/services/users.ts`:

```ts
/** Read welcome eligibility without consuming the once-per-account claim. */
async welcomeStatus(id: string): Promise<{ pending: boolean }> {
  const rows = await db
    .select({ welcomeClaimed: users.welcomeClaimed })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return { pending: rows[0]?.welcomeClaimed === false };
},
```

- [ ] **Step 4: Run the service test and verify GREEN**

Run:

```bash
npm --prefix server test -- src/test/users.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Write failing route tests**

Add these tests to the welcome route suite in `server/src/test/account-routes.test.ts`:

```ts
it("reads pending status without consuming the welcome claim", async () => {
  ctx = await makeTestDb({ signupFaucet: false });
  await bindDevWallet(ctx, "alice");

  const before = await ctx.server.inject({ method: "GET", url: "/v1/welcome/status", headers: H });
  const again = await ctx.server.inject({ method: "GET", url: "/v1/welcome/status", headers: H });
  const claim = await ctx.server.inject({ method: "POST", url: "/v1/welcome/claim", headers: H, payload: {} });
  const after = await ctx.server.inject({ method: "GET", url: "/v1/welcome/status", headers: H });

  expect(before.statusCode).toBe(200);
  expect(before.json()).toEqual({ pending: true });
  expect(again.json()).toEqual({ pending: true });
  expect(claim.json()).toEqual({ granted: true });
  expect(after.json()).toEqual({ pending: false });
});

it("requires a wallet-bound account for welcome status", async () => {
  ctx = await makeTestDb({ signupFaucet: false });

  const res = await ctx.server.inject({ method: "GET", url: "/v1/welcome/status", headers: H });

  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: "wallet_required" });
});
```

- [ ] **Step 6: Run the route tests and verify RED**

Run:

```bash
npm --prefix server test -- src/test/account-routes.test.ts
```

Expected: FAIL because `GET /v1/welcome/status` returns 404.

- [ ] **Step 7: Implement the wallet-bound status route**

Insert before `POST /v1/welcome/claim` in `server/src/http/routes.ts`:

```ts
// Read-only preflight. The welcome claim remains pending until VRF succeeds and the client
// calls the atomic claim endpoint below.
server.get("/v1/welcome/status", { preHandler: requireWalletBoundUser }, async (req) => {
  return deps.users.welcomeStatus(req.userId!);
});
```

- [ ] **Step 8: Run the server tests and build**

Run:

```bash
npm --prefix server test -- src/test/users.test.ts src/test/account-routes.test.ts
npm --prefix server run build
```

Expected: both commands exit 0 with no failed tests or TypeScript errors.

- [ ] **Step 9: Commit the Railway status slice**

```bash
git add server/src/services/users.ts server/src/http/routes.ts server/src/test/users.test.ts server/src/test/account-routes.test.ts
git commit -m "feat: expose pending welcome crate status"
```

---

### Task 2: Add the read-only welcome status to the web API client

**Files:**
- Modify: `redline3d/src/core/api.ts`
- Test: `redline3d/src/core/api.test.ts`
- Modify: `redline3d/src/core/round-sync.test.ts`

**Interfaces:**
- Consumes: `GET /v1/welcome/status -> { pending: boolean }`
- Produces: `Api.welcomeStatus(): Promise<{ pending: boolean }>`
- Preserves: `Api.claimWelcome(): Promise<{ granted: boolean }>`

- [ ] **Step 1: Write the failing client request test**

Add to `describe("createApi")` in `redline3d/src/core/api.test.ts`:

```ts
it("reads welcome status before posting the atomic claim", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const api = createApi({
    baseUrl: "http://x",
    userId: "u",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return String(url).endsWith("/status")
        ? res(200, { pending: true })
        : res(200, { granted: true });
    },
  });

  await expect(api.welcomeStatus()).resolves.toEqual({ pending: true });
  await expect(api.claimWelcome()).resolves.toEqual({ granted: true });
  expect(calls).toEqual([
    { url: "http://x/v1/welcome/status", method: "GET", body: undefined },
    { url: "http://x/v1/welcome/claim", method: "POST", body: {} },
  ]);
});
```

- [ ] **Step 2: Run the API test and verify RED**

Run:

```bash
npm --prefix redline3d test -- src/core/api.test.ts
```

Expected: FAIL because `api.welcomeStatus` does not exist.

- [ ] **Step 3: Implement the typed API method**

Add to the `Api` interface in `redline3d/src/core/api.ts`:

```ts
/** Read welcome eligibility without consuming the once-per-account claim. */
welcomeStatus(): Promise<{ pending: boolean }>;
```

Add to the `createApi` return object immediately before `claimWelcome`:

```ts
welcomeStatus: () => call("GET", "/v1/welcome/status"),
```

Add the method to the complete `Api` double in `redline3d/src/core/round-sync.test.ts`:

```ts
welcomeStatus: async () => ({ pending: false }),
```

- [ ] **Step 4: Run the API test and client typecheck**

Run:

```bash
npm --prefix redline3d test -- src/core/api.test.ts
npm --prefix redline3d run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the API contract**

```bash
git add redline3d/src/core/api.ts redline3d/src/core/api.test.ts redline3d/src/core/round-sync.test.ts
git commit -m "feat: read welcome crate eligibility"
```

---

### Task 3: Make crate randomness policy explicit and fail closed

**Files:**
- Modify: `redline3d/src/ui/cratebox.ts`
- Test: `redline3d/src/ui/cratebox.test.ts`

**Interfaces:**
- Produces: `crateRandomnessMode(vrfRequired: boolean, hasProvider: boolean): "vrf" | "client" | "blocked"`
- Produces: `completeVrfReward(free, completeGift, applyReward): Promise<boolean>`
- Adds: `CrateBoxDeps.vrfRequired?: () => boolean`
- Adds: `CrateBoxDeps.completeGift?: () => Promise<boolean>`

- [ ] **Step 1: Replace the old welcome policy test with failing explicit-policy tests**

Replace the `welcome crate randomness policy` suite in `redline3d/src/ui/cratebox.test.ts` with:

```ts
describe("crate randomness policy", () => {
  test("requires VRF for every signed-in crate, including free welcome crates", () => {
    const mode = (crateboxModule as unknown as {
      crateRandomnessMode?: (required: boolean, hasProvider: boolean) => "vrf" | "client" | "blocked";
    }).crateRandomnessMode;

    expect(mode?.(true, true)).toBe("vrf");
    expect(mode?.(true, false)).toBe("blocked");
    expect(mode?.(false, false)).toBe("client");
  });

  test("completes a free welcome claim before applying its VRF reward", async () => {
    const complete = (crateboxModule as unknown as {
      completeVrfReward?: (
        free: boolean,
        completeGift: (() => Promise<boolean>) | undefined,
        applyReward: () => boolean,
      ) => Promise<boolean>;
    }).completeVrfReward!;
    const events: string[] = [];

    const revealed = await complete(
      true,
      async () => { events.push("claim"); return true; },
      () => { events.push("reward"); return true; },
    );

    expect(revealed).toBe(true);
    expect(events).toEqual(["claim", "reward"]);
  });

  test("does not apply a welcome reward when atomic completion loses", async () => {
    const complete = (crateboxModule as unknown as {
      completeVrfReward?: (
        free: boolean,
        completeGift: (() => Promise<boolean>) | undefined,
        applyReward: () => boolean,
      ) => Promise<boolean>;
    }).completeVrfReward!;
    let grants = 0;

    await expect(complete(true, async () => false, () => { grants++; return true; })).resolves.toBe(false);
    expect(grants).toBe(0);
  });
});
```

- [ ] **Step 2: Run the cratebox test and verify RED**

Run:

```bash
npm --prefix redline3d test -- src/ui/cratebox.test.ts
```

Expected: FAIL because `crateRandomnessMode` and `completeVrfReward` do not exist.

- [ ] **Step 3: Add the explicit policy and completion helpers**

Replace `shouldUseVrfForOpen` in `redline3d/src/ui/cratebox.ts` with:

```ts
export type CrateRandomnessMode = "vrf" | "client" | "blocked";

/** Signed-in crates fail closed; only guest practice may use browser randomness. */
export function crateRandomnessMode(vrfRequired: boolean, hasProvider: boolean): CrateRandomnessMode {
  if (hasProvider) return "vrf";
  return vrfRequired ? "blocked" : "client";
}

/** A free account reward is applied only after the once-per-account claim wins. */
export async function completeVrfReward(
  free: boolean,
  completeGift: (() => Promise<boolean>) | undefined,
  applyReward: () => boolean,
): Promise<boolean> {
  if (free && (!completeGift || !(await completeGift()))) return false;
  return applyReward();
}
```

Add to `CrateBoxDeps`:

```ts
/** True for account-backed crates. These must never fall back to browser RNG. */
vrfRequired?: () => boolean;
/** Atomic server completion for a free signed-in welcome crate, called after VRF succeeds. */
completeGift?: () => Promise<boolean>;
```

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run:

```bash
npm --prefix redline3d test -- src/ui/cratebox.test.ts
```

Expected: PASS.

- [ ] **Step 5: Route `doOpen` through the explicit mode**

Replace the current `availableVrf` and `vrfProvider` setup at the top of `doOpen` with:

```ts
const vrfRequired = deps.vrfRequired?.() ?? false;
const availableVrf = deps.vrfDraws?.() ?? null;
const randomnessMode = crateRandomnessMode(vrfRequired, !!availableVrf);
if (randomnessMode === "blocked") {
  deps.onVrfFail?.("Connect and fund your wallet to open this crate with MagicBlock VRF.");
  if (giftMode) { giftMode = false; close(); }
  return;
}
const vrfProvider = randomnessMode === "vrf" ? availableVrf : null;
```

The existing synchronous branch remains under `if (!vrfProvider)`. No edits are required inside that branch: the new `blocked` return makes it reachable only when client RNG is explicitly permitted.

Replace the VRF success callback with this async completion sequence:

```ts
void vrfProvider(4).then(async (draws) => {
  if (!free) deps.settleHold!(crate.priceCoins, true);
  const revealed = await completeVrfReward(
    free,
    deps.completeGift,
    () => resolveAndReveal(crate, draws, true),
  );
  if (!revealed) {
    opening = false;
    if (giftMode) { giftMode = false; close(); } else showShop();
  }
}).catch((error) => {
  if (!free) deps.settleHold!(crate.priceCoins, false);
  opening = false;
  console.warn("[crate] verified open failed:", error);
  deps.onVrfFail?.(vrfFailureMessage(error, !free));
  if (giftMode) { giftMode = false; close(); } else showShop();
});
```

Change the failure helper signature to distinguish a paid hold from a free gift:

```ts
export function vrfFailureMessage(error: unknown, coinsHeld = true): string {
  const suffix = coinsHeld ? " Your coins were restored." : "";
  const cause = error instanceof Error && "cause" in error
    ? String((error as Error & { cause?: unknown }).cause ?? "")
    : "";
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${cause}`
    : String(error);
  if (/prior credit|insufficient (funds|lamports).*fee|insufficient.*balance/i.test(text)) {
    return `This wallet needs devnet SOL for VRF. Open Wallet, send a little SOL, then try again.${suffix}`;
  }
  if (/vrf_timeout/i.test(text)) return `The randomness oracle timed out. Try again.${suffix}`;
  if (/429|too many requests|failed to fetch|network/i.test(text)) {
    return `The devnet connection is busy. Try again shortly.${suffix}`;
  }
  return `The verified crate open failed. Try again.${suffix}`;
}
```

- [ ] **Step 6: Extend failure-copy tests**

Add to the existing failure test in `redline3d/src/ui/cratebox.test.ts`:

```ts
expect(messageFor?.(new Error("vrf_timeout"), false)).not.toContain("coins were restored");
expect(messageFor?.(new Error("vrf_timeout"), true)).toContain("coins were restored");
```

Update the extracted test type to accept the second argument:

```ts
vrfFailureMessage?: (error: unknown, coinsHeld?: boolean) => string;
```

- [ ] **Step 7: Run crate tests and client build**

Run:

```bash
npm --prefix redline3d test -- src/ui/cratebox.test.ts src/core/vrf-draws.test.ts
npm --prefix redline3d run build
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit the fail-closed crate policy**

```bash
git add redline3d/src/ui/cratebox.ts redline3d/src/ui/cratebox.test.ts
git commit -m "feat: require VRF for signed-in crates"
```

---

### Task 4: Wire retryable welcome status and completion into the app

**Files:**
- Modify: `redline3d/src/core/welcome.ts`
- Test: `redline3d/src/core/welcome.test.ts`
- Modify: `redline3d/src/main.ts`

**Interfaces:**
- Consumes: `Api.welcomeStatus()` and `Api.claimWelcome()`
- Consumes: `CrateBoxDeps.vrfRequired` and `CrateBoxDeps.completeGift`
- Produces: `offerPendingAccountWelcome(readStatus, openGift): Promise<boolean>`

- [ ] **Step 1: Write failing coordinator tests**

Add to `redline3d/src/core/welcome.test.ts`:

```ts
describe("pending signed-in welcome offer", () => {
  test("opens only when the read-only server status is pending", async () => {
    const offer = (welcomeModule as unknown as {
      offerPendingAccountWelcome?: (
        readStatus: () => Promise<{ pending: boolean }>,
        openGift: () => void,
      ) => Promise<boolean>;
    }).offerPendingAccountWelcome!;
    let opens = 0;

    await expect(offer(async () => ({ pending: true }), () => { opens++; })).resolves.toBe(true);
    await expect(offer(async () => ({ pending: false }), () => { opens++; })).resolves.toBe(false);
    expect(opens).toBe(1);
  });
});
```

- [ ] **Step 2: Run the welcome test and verify RED**

Run:

```bash
npm --prefix redline3d test -- src/core/welcome.test.ts
```

Expected: FAIL because `offerPendingAccountWelcome` does not exist.

- [ ] **Step 3: Implement the pending-offer coordinator**

Add to `redline3d/src/core/welcome.ts`:

```ts
/** Offer an account welcome gift without consuming it. Completion happens after VRF. */
export async function offerPendingAccountWelcome(
  readStatus: () => Promise<{ pending: boolean }>,
  openGift: () => void,
): Promise<boolean> {
  const { pending } = await readStatus();
  if (!pending) return false;
  openGift();
  return true;
}
```

- [ ] **Step 4: Run the welcome test and verify GREEN**

Run:

```bash
npm --prefix redline3d test -- src/core/welcome.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire account-backed crate policy and completion in `main.ts`**

Import `ApiError` with `createApi`, and import `offerPendingAccountWelcome` from `core/welcome`.

Add these dependencies to the existing `createCrateBox` call:

```ts
vrfRequired: () => identity?.mode === "privy",
completeGift: async () => {
  try {
    return (await api.claimWelcome()).granted;
  } catch (error) {
    if (error instanceof ApiError && error.bodyError === "welcome_already_claimed") return false;
    throw error;
  }
},
```

Leave `vrfDraws` wallet construction unchanged. It now runs for free and paid signed-in opens because `cratebox.ts` no longer removes the provider for `free`.

Replace `claimWelcomeAccount` with:

```ts
async function offerWelcomeAccount() {
  try {
    await offerPendingAccountWelcome(
      () => api.welcomeStatus(),
      () => setTimeout(() => crateBox.openGift("wooden"), 0),
    );
  } catch {
    // Railway is the account source of truth. Never fall back to a local signed-in gift.
  }
}
```

Replace both `void claimWelcomeAccount();` call sites with:

```ts
void offerWelcomeAccount();
```

Remove the now-unused `shouldDeliverAccountWelcome` import from `main.ts`. Keep the exported helper in `welcome.ts` for compatibility with its existing unit test unless a separate cleanup is desired later.

- [ ] **Step 6: Run targeted integration tests and build**

Run:

```bash
npm --prefix redline3d test -- src/core/welcome.test.ts src/core/api.test.ts src/ui/cratebox.test.ts
npm --prefix redline3d run build
```

Expected: both commands exit 0. TypeScript must confirm all `Api` implementations include `welcomeStatus` and the main wiring matches the crate dependency types.

- [ ] **Step 7: Commit the app integration**

```bash
git add redline3d/src/core/welcome.ts redline3d/src/core/welcome.test.ts redline3d/src/main.ts
git commit -m "feat: make welcome crate VRF retryable"
```

---

### Task 5: Full regression verification

**Files:**
- Verify only

**Interfaces:**
- Verifies all previous task outputs together.

- [ ] **Step 1: Run all Railway tests**

```bash
npm --prefix server test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Run the Railway build**

```bash
npm --prefix server run build
```

Expected: exit 0 with zero TypeScript errors.

- [ ] **Step 3: Run all web client tests**

```bash
npm --prefix redline3d test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 4: Run the web production build**

```bash
npm --prefix redline3d run build
```

Expected: exit 0 with zero TypeScript or Vite build errors.

- [ ] **Step 5: Inspect the final diff and commit state**

```bash
git diff --check
git status --short --branch
git log -5 --oneline
```

Expected: no whitespace errors, only the pre-existing untracked `artifacts/` directory remains, and all implementation slices are committed.
