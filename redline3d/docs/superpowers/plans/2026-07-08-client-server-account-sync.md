# Client → Server Account Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the redline3d client's **coins, scrap, and cars** through `@perps/server` (Plan 1's account-state API) so a signed-in player's soft economy follows them across devices, while the game stays instant and offline-playable.

**Architecture:** The localStorage-backed `Upgrades` and `Inventory` stores stay the **instant-UI cache**. A new `core/account-sync.ts` orchestrator holds the authenticated `Api` and:
- on sign-in, calls `GET /v1/me`; if the server account is empty it **seeds** it from the local save (`POST /v1/migrate`, first-bind), otherwise the **server is authoritative** and its snapshot overwrites the local cache (never summed);
- on every coins/scrap/car mutation, fires a **best-effort idempotent delta** (`/v1/coins|scrap/earn|spend`, `/v1/inventory/grant|melt`) — failures are swallowed and reconcile on the next sign-in load.

Guests (walletless practice) never touch the server; the forwarders no-op until a signed-in session has hydrated. The stores gain sync hooks (matching their existing `onCoins`/`onScrap` callback pattern) and a `hydrate()` to accept server truth, so they never import the API themselves.

**Tech Stack:** TypeScript, Vite, Vitest. Client only — the server side (Plan 1) is already shipped and green.

**Scope note:** This is **Plan 2 of 3** for the cross-platform Privy pillar (spec: `docs/superpowers/specs/2026-07-07-crossplatform-privy-account-design.md`; Plan 1: `docs/superpowers/plans/2026-07-07-server-account-state-api.md`, done). Synced this slice: **coins, scrap, and the car inventory (`redline.owned.v1`)**. Deferred (no server home yet): upgrade **levels**, per-car **finishes**, and **world skins** (`redline.levels.v1`) — they remain local-only until a follow-up adds columns for them. Plan 3 = cross-platform shell (branding, WebView login, perf, APK/PWA).

**Server endpoints consumed (from Plan 1, verified shapes):**
- `GET /v1/me` → `{ userId, balance, coins, scrap, cars: [{carId, count, acquiredAt}], openRoundId }`
- `POST /v1/coins/earn` `{amount, ref}` → `{ coins }`
- `POST /v1/coins/spend` `{amount, ref}` → `{ coins }` | 402 `{error:"insufficient_balance"}`
- `POST /v1/scrap/earn` / `POST /v1/scrap/spend` `{amount, ref}` → `{ scrap }`
- `POST /v1/inventory/grant` `{carId}` → `{ carId, isNew, count }`
- `POST /v1/inventory/melt` `{carId}` → `{ carId, melted, count }`
- `POST /v1/migrate` `{coins, scrap, cars: {id:n}}` → `{ seeded: true }` | `{ seeded: false, reason: "account_not_empty" }`

All commands run from `redline3d/`.

---

## File Structure

- **Modify** `src/core/api.ts` — extend `MeResult` (add `coins`, `scrap`, `cars[].count`); add 7 account methods to the `Api` interface + implementations.
- **Create** `src/core/account-sync.ts` — the sync orchestrator (`createAccountSync`): `hydrate` + delta forwarders + enable/disable.
- **Create** `src/core/account-sync.test.ts`.
- **Modify** `src/ui/upgrades.ts` — add an `onMutate` opt fired inside `addCoins`/`spend`/`addScrap`/`spendScrap` + internal `buy`; add `hydrate({coins,scrap})`.
- **Modify** `src/ui/upgrades.test.ts` — cover `onMutate` + `hydrate`.
- **Modify** `src/core/inventory.ts` — add a 4th `hooks` param (`onGrant`/`onMelt`); add `hydrate(counts)` + `snapshot()` to the interface.
- **Modify** `src/core/inventory.test.ts` — cover hooks + `hydrate` + `snapshot`.
- **Modify** `src/chain/game-session.ts` — expose `signMessage(message)` on `GameSession` (delegates to the private wallet port).
- **Modify** `src/chain/game-session.test.ts` — cover `signMessage`.
- **Create** `src/core/sign-in-sync.ts` — `bindAndHydrate()` pure orchestrator (bind Privy → adopt session → hydrate).
- **Create** `src/core/sign-in-sync.test.ts`.
- **Modify** `src/main.ts` — instantiate `auth`/`api`/`accountSync`; inject store hooks; call `bindAndHydrate` on sign-in; `disable` on logout.

---

## Task 1: Extend `core/api.ts` with account state + delta methods

**Files:**
- Modify: `src/core/api.ts:7` (MeResult), `src/core/api.ts:33-50` (Api interface), `src/core/api.ts:128-139` (implementations)
- Modify: `src/core/api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/api.test.ts` (inside the existing `describe("createApi", ...)`, before its closing `});`):

```ts
  it("posts coin/scrap deltas and inventory ops to the account endpoints", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const mk = (body: unknown) =>
      createApi({
        baseUrl: "http://x", userId: "u",
        fetch: async (url, init) => {
          seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
          return res(200, body);
        },
      });

    expect(await mk({ coins: 30 }).coinsEarn({ amount: 30, ref: "e1" })).toEqual({ coins: 30 });
    expect(seen[0]).toEqual({ url: "http://x/v1/coins/earn", body: { amount: 30, ref: "e1" } });

    expect(await mk({ coins: 18 }).coinsSpend({ amount: 12, ref: "s1" })).toEqual({ coins: 18 });
    expect(seen[1].url).toBe("http://x/v1/coins/spend");

    expect(await mk({ scrap: 5 }).scrapEarn({ amount: 5, ref: "se1" })).toEqual({ scrap: 5 });
    expect(seen[2].url).toBe("http://x/v1/scrap/earn");

    expect(await mk({ carId: "orion", isNew: true, count: 1 }).inventoryGrant({ carId: "orion" }))
      .toEqual({ carId: "orion", isNew: true, count: 1 });
    expect(seen[3]).toEqual({ url: "http://x/v1/inventory/grant", body: { carId: "orion" } });

    expect(await mk({ seeded: true }).migrate({ coins: 10, scrap: 2, cars: { orion: 1 } }))
      .toEqual({ seeded: true });
    expect(seen[4].url).toBe("http://x/v1/migrate");
  });

  it("maps a 402 coin spend to insufficient_balance", async () => {
    const api = createApi({ baseUrl: "http://x", userId: "u", fetch: async () => res(402, { error: "insufficient_balance" }) });
    await expect(api.coinsSpend({ amount: 9, ref: "x" })).rejects.toMatchObject({ code: "insufficient_balance" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/api.test.ts`
Expected: FAIL — `coinsEarn`, `coinsSpend`, `scrapEarn`, `inventoryGrant`, `migrate` do not exist on `Api`.

- [ ] **Step 3: Extend `MeResult`**

In `src/core/api.ts`, replace line 7:

```ts
export interface MeResult { userId: string; balance: number; coins: number; scrap: number; cars: { carId: string; count: number; acquiredAt?: string }[]; openRoundId: string | null; }
```

- [ ] **Step 4: Add the method signatures to the `Api` interface**

In `src/core/api.ts`, inside `export interface Api { ... }`, add after `me(): Promise<MeResult>;` (line 34):

```ts
  coinsEarn(p: { amount: number; ref: string }): Promise<{ coins: number }>;
  coinsSpend(p: { amount: number; ref: string }): Promise<{ coins: number }>;
  scrapEarn(p: { amount: number; ref: string }): Promise<{ scrap: number }>;
  scrapSpend(p: { amount: number; ref: string }): Promise<{ scrap: number }>;
  inventoryGrant(p: { carId: string }): Promise<{ carId: string; isNew: boolean; count: number }>;
  inventoryMelt(p: { carId: string }): Promise<{ carId: string; melted: boolean; count: number }>;
  migrate(p: { coins: number; scrap: number; cars: Record<string, number> }): Promise<{ seeded: boolean; reason?: string }>;
```

- [ ] **Step 5: Add the implementations**

In `src/core/api.ts`, inside the `return { ... }` of `createApi`, add after `me: () => call<MeResult>("GET", "/v1/me"),` (line 129):

```ts
    coinsEarn: (p) => call("POST", "/v1/coins/earn", p),
    coinsSpend: (p) => call("POST", "/v1/coins/spend", p),
    scrapEarn: (p) => call("POST", "/v1/scrap/earn", p),
    scrapSpend: (p) => call("POST", "/v1/scrap/spend", p),
    inventoryGrant: (p) => call("POST", "/v1/inventory/grant", p),
    inventoryMelt: (p) => call("POST", "/v1/inventory/melt", p),
    migrate: (p) => call("POST", "/v1/migrate", p),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/core/api.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add src/core/api.ts src/core/api.test.ts
git commit -m "feat(client): account-state + delta methods on the Api"
```

---

## Task 2: The account-sync orchestrator

**Files:**
- Create: `src/core/account-sync.ts`
- Create: `src/core/account-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/account-sync.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createAccountSync, type AccountSnapshot } from "./account-sync";
import type { Api } from "./api";

function fakeApi(over: Partial<Api> = {}): Api {
  const base: Partial<Api> = {
    me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null })),
    coinsEarn: vi.fn(async () => ({ coins: 0 })),
    coinsSpend: vi.fn(async () => ({ coins: 0 })),
    scrapEarn: vi.fn(async () => ({ scrap: 0 })),
    scrapSpend: vi.fn(async () => ({ scrap: 0 })),
    inventoryGrant: vi.fn(async () => ({ carId: "x", isNew: true, count: 1 })),
    inventoryMelt: vi.fn(async () => ({ carId: "x", melted: true, count: 1 })),
    migrate: vi.fn(async () => ({ seeded: true })),
  };
  return { ...base, ...over } as Api;
}
const empty: AccountSnapshot = { coins: 0, scrap: 0, cars: {} };

describe("createAccountSync", () => {
  it("forwarders no-op until hydrated, then post idempotent deltas", async () => {
    const api = fakeApi();
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });

    sync.coinsEarned(10); // disabled → ignored
    expect(api.coinsEarn).not.toHaveBeenCalled();

    await sync.hydrate(empty); // server empty + local empty → server-wins, enabled
    expect(sync.enabled()).toBe(true);

    sync.coinsEarned(10);
    sync.coinsEarned(5);
    await Promise.resolve();
    expect(api.coinsEarn).toHaveBeenNthCalledWith(1, { amount: 10, ref: "t:coinsEarn:0" });
    expect(api.coinsEarn).toHaveBeenNthCalledWith(2, { amount: 5, ref: "t:coinsEarn:1" });
  });

  it("seeds the server from local when the account is empty", async () => {
    const api = fakeApi();
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    const outcome = await sync.hydrate({ coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } });
    expect(outcome).toBe("seeded");
    expect(api.migrate).toHaveBeenCalledWith({ coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } });
  });

  it("overwrites the local cache from server truth when the account is non-empty", async () => {
    const applyServer = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 500, scrap: 12, cars: [{ carId: "orion", count: 3, acquiredAt: "t" }], openRoundId: null })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    const outcome = await sync.hydrate({ coins: 250, scrap: 30, cars: { skull: 1 } });
    expect(outcome).toBe("server");
    expect(api.migrate).not.toHaveBeenCalled(); // never sum local + server
    expect(applyServer).toHaveBeenCalledWith({ coins: 500, scrap: 12, cars: { orion: 3 } });
  });

  it("guest (api null) stays offline and never posts", async () => {
    const sync = createAccountSync({ api: null, nonce: "t", applyServer: () => {} });
    expect(await sync.hydrate({ coins: 99, scrap: 9, cars: {} })).toBe("offline");
    expect(sync.enabled()).toBe(false);
    sync.coinsEarned(10); // no throw, no-op
  });

  it("a failed /v1/me leaves it disabled (offline), game plays on cache", async () => {
    const api = fakeApi({ me: vi.fn(async () => { throw new Error("network"); }) });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    expect(await sync.hydrate(empty)).toBe("offline");
    expect(sync.enabled()).toBe(false);
  });

  it("swallows best-effort write failures without throwing", async () => {
    const api = fakeApi({ coinsEarn: vi.fn(async () => { throw new Error("boom"); }) });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    await sync.hydrate(empty);
    expect(() => sync.coinsEarned(10)).not.toThrow();
    await Promise.resolve();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/account-sync.test.ts`
Expected: FAIL — `./account-sync` does not exist.

- [ ] **Step 3: Write the orchestrator**

Create `src/core/account-sync.ts`:

```ts
import type { Api } from "./api";

/** the player's soft account state, mirrored between the local cache and the server ledger. */
export interface AccountSnapshot {
  coins: number;
  scrap: number;
  cars: Record<string, number>; // carId -> count owned
}

export interface AccountSync {
  /** true once a signed-in session has hydrated; forwarders no-op until then (guests stay local). */
  enabled(): boolean;
  /** On sign-in: reconcile local vs server. Server EMPTY + local has state → SEED the server from
   *  local (first-bind migration). Otherwise the server is authoritative and its snapshot is written
   *  back into the local cache via `applyServer` (never summed). Offline/guest → disabled, cache-only. */
  hydrate(local: AccountSnapshot): Promise<"seeded" | "server" | "offline">;
  /** drop server authority (logout / account switch); forwarders no-op again. */
  disable(): void;
  coinsEarned(n: number): void;
  coinsSpent(n: number): void;
  scrapEarned(n: number): void;
  scrapSpent(n: number): void;
  carGranted(carId: string): void;
  carMelted(carId: string): void;
}

export interface AccountSyncOpts {
  /** the authenticated API, or null for a guest (forwarders no-op, hydrate returns "offline"). */
  api: Api | null;
  /** write a server-authoritative snapshot back into the local stores (cache). */
  applyServer: (snap: AccountSnapshot) => void;
  /** stable per-load nonce so replayed deltas dedupe but distinct earns don't collide. */
  nonce: string;
  /** optional sink for best-effort write failures (telemetry/debug); defaults to swallow. */
  onError?: (where: string, err: unknown) => void;
}

export function createAccountSync(opts: AccountSyncOpts): AccountSync {
  let on = false;
  let seq = 0;
  const ref = (kind: string) => `${opts.nonce}:${kind}:${seq++}`;
  const swallow = (where: string) => (err: unknown) => opts.onError?.(where, err);
  // Best-effort fire-and-forget: the local cache already updated the UI, so a failed server write
  // reconciles on the next sign-in load (server wins). Never throws into the caller.
  const fire = (where: string, p: Promise<unknown> | undefined) => { void p?.catch(swallow(where)); };

  return {
    enabled: () => on,
    disable: () => { on = false; },

    async hydrate(local) {
      const api = opts.api;
      if (!api) return "offline";
      let me: Awaited<ReturnType<Api["me"]>>;
      try {
        me = await api.me();
      } catch (e) {
        swallow("me")(e);
        on = false;
        return "offline";
      }
      const serverEmpty = (me.coins ?? 0) === 0 && (me.scrap ?? 0) === 0 && (me.cars?.length ?? 0) === 0;
      const localHasState = local.coins > 0 || local.scrap > 0 || Object.keys(local.cars).length > 0;
      if (serverEmpty && localHasState) {
        try {
          await api.migrate({ coins: local.coins, scrap: local.scrap, cars: local.cars });
          on = true;
          return "seeded";
        } catch (e) {
          swallow("migrate")(e);
          on = false;
          return "offline";
        }
      }
      // server is authoritative — overwrite the local cache with its truth (never sum)
      opts.applyServer({
        coins: me.coins ?? 0,
        scrap: me.scrap ?? 0,
        cars: Object.fromEntries((me.cars ?? []).map((c) => [c.carId, c.count ?? 1])),
      });
      on = true;
      return "server";
    },

    coinsEarned(n) { if (on && opts.api && n > 0) fire("coinsEarn", opts.api.coinsEarn({ amount: Math.floor(n), ref: ref("coinsEarn") })); },
    coinsSpent(n) { if (on && opts.api && n > 0) fire("coinsSpend", opts.api.coinsSpend({ amount: Math.floor(n), ref: ref("coinsSpend") })); },
    scrapEarned(n) { if (on && opts.api && n > 0) fire("scrapEarn", opts.api.scrapEarn({ amount: Math.floor(n), ref: ref("scrapEarn") })); },
    scrapSpent(n) { if (on && opts.api && n > 0) fire("scrapSpend", opts.api.scrapSpend({ amount: Math.floor(n), ref: ref("scrapSpend") })); },
    carGranted(carId) { if (on && opts.api) fire("inventoryGrant", opts.api.inventoryGrant({ carId })); },
    carMelted(carId) { if (on && opts.api) fire("inventoryMelt", opts.api.inventoryMelt({ carId })); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/account-sync.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/core/account-sync.ts src/core/account-sync.test.ts
git commit -m "feat(client): account-sync orchestrator (hydrate + best-effort deltas)"
```

---

## Task 3: `Upgrades` sync hooks + hydrate

**Files:**
- Modify: `src/ui/upgrades.ts:121-124` (opts), `:187-196` (buy), `:212-218` (returned methods)
- Modify: `src/ui/upgrades.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/upgrades.test.ts` (inside the top-level `describe`, matching the existing `createUpgrades(root, {})` helper on line 34):

```ts
  it("fires onMutate for earns and spends, and hydrate overwrites without firing", () => {
    const root = document.createElement("div");
    const events: { kind: string; amount: number }[] = [];
    const up = createUpgrades(root, { onMutate: (e) => events.push(e) });

    up.addCoins(40);
    up.addScrap(6);
    expect(events).toEqual([{ kind: "coinsEarn", amount: 40 }, { kind: "scrapEarn", amount: 6 }]);

    expect(up.spend(15)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "coinsSpend", amount: 15 });

    expect(up.spend(9999)).toBe(false); // can't afford → no event
    expect(events.filter((e) => e.kind === "coinsSpend").length).toBe(1);

    // hydrate = accept server truth; it must NOT echo back as a mutation
    const before = events.length;
    up.hydrate({ coins: 500, scrap: 20 });
    expect(up.coins()).toBe(500);
    expect(up.scrap()).toBe(20);
    expect(events.length).toBe(before);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/upgrades.test.ts`
Expected: FAIL — `onMutate` is not an opt and `hydrate` is not on `Upgrades`.

- [ ] **Step 3: Add `onMutate` to the opts type + `hydrate` to the interface**

In `src/ui/upgrades.ts`, in the `Upgrades` interface (after `setBusy(busy: boolean): void;`, line 82), add:

```ts
  /** overwrite the cached balances from server truth (no onMutate fired) + refresh the HUD */
  hydrate(s: { coins: number; scrap: number }): void;
```

Change the `createUpgrades` signature opts (line 122-123) to add `onMutate`:

```ts
export function createUpgrades(
  parent: HTMLElement,
  opts: { onCoins?: (n: number) => void; onScrap?: (n: number) => void; onApply?: () => void; economicEffects?: boolean; onClose?: () => void; onMutate?: (ev: { kind: "coinsEarn" | "coinsSpend" | "scrapEarn" | "scrapSpend"; amount: number }) => void } = {},
): Upgrades {
```

- [ ] **Step 4: Fire `onMutate` in `buy` and the returned methods**

In `buy` (line 187-196), after `saved.coins -= cost;` add the spend event. Replace the body of `buy`:

```ts
  const buy = (key: Track) => {
    const lvl = saved.levels[key];
    if (lvl >= MAX_LEVEL) return;
    const cost = upgradeCost(lvl);
    if (saved.coins < cost) return;
    saved.coins -= cost;
    saved.levels[key] = lvl + 1;
    apply(); persist(); render();
    opts.onCoins?.(saved.coins);
    opts.onMutate?.({ kind: "coinsSpend", amount: cost });
  };
```

Replace the returned `addCoins`/`spend`/`addScrap`/`spendScrap` (lines 214-218) and add `hydrate`:

```ts
    coins: () => saved.coins,
    addCoins(n) { saved.coins = addCoinsRaw(saved.coins, n); persist(); opts.onCoins?.(saved.coins); opts.onMutate?.({ kind: "coinsEarn", amount: Math.floor(n) }); },
    spend(n) { if (saved.coins < n) return false; const amt = Math.floor(n); saved.coins = Math.max(0, saved.coins - amt); persist(); opts.onCoins?.(saved.coins); opts.onMutate?.({ kind: "coinsSpend", amount: amt }); return true; },
    scrap: () => saved.scrap,
    addScrap(n) { saved.scrap = addCoinsRaw(saved.scrap, n); persist(); opts.onScrap?.(saved.scrap); opts.onMutate?.({ kind: "scrapEarn", amount: Math.floor(n) }); },
    spendScrap(n) { if (saved.scrap < n) return false; const amt = Math.floor(n); saved.scrap = Math.max(0, saved.scrap - amt); persist(); opts.onScrap?.(saved.scrap); opts.onMutate?.({ kind: "scrapSpend", amount: amt }); return true; },
    hydrate(s) { saved.coins = Math.max(0, Math.floor(s.coins)); saved.scrap = Math.max(0, Math.floor(s.scrap)); persist(); opts.onCoins?.(saved.coins); opts.onScrap?.(saved.scrap); if (overlay.style.display !== "none") render(); },
```

(`overlay` and `render` are both in scope at the `return` — defined earlier in the function.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/ui/upgrades.test.ts`
Expected: PASS (all, including the existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/ui/upgrades.ts src/ui/upgrades.test.ts
git commit -m "feat(client): Upgrades onMutate hooks + hydrate(server truth)"
```

---

## Task 4: `Inventory` sync hooks + hydrate + snapshot

**Files:**
- Modify: `src/core/inventory.ts:5-18` (interface), `:21` (signature), `:44-63` (returned methods)
- Modify: `src/core/inventory.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/inventory.test.ts` (matching its `memStorage()`/`memStore()` helpers — reuse whichever the file defines; the calls below assume a `memStore()` returning a fresh `Storage`):

```ts
  it("fires hooks on grant/melt and snapshots counts", () => {
    const grants: { id: string; isNew: boolean }[] = [];
    const melts: { id: string; melted: boolean }[] = [];
    const inv = createInventory("k", ["Starter"], memStore(), {
      onGrant: (id, isNew) => grants.push({ id, isNew }),
      onMelt: (id, melted) => melts.push({ id, melted }),
    });

    inv.grant("Orion");
    inv.grant("Orion");
    expect(grants).toEqual([{ id: "Orion", isNew: true }, { id: "Orion", isNew: false }]);

    expect(inv.melt("Orion")).toBe(true);
    expect(melts).toEqual([{ id: "Orion", melted: true }]);
    expect(inv.melt("Orion")).toBe(false); // last copy kept → melted:false still reported
    expect(melts.at(-1)).toEqual({ id: "Orion", melted: false });

    expect(inv.snapshot()).toEqual({ Starter: 1, Orion: 1 });
  });

  it("hydrate replaces counts from a server snapshot (free floor re-applied, no hooks)", () => {
    const grants: unknown[] = [];
    const inv = createInventory("k", ["Starter"], memStore(), { onGrant: () => grants.push(1) });
    inv.grant("Orion");
    inv.hydrate({ Skull: 2, Helmet: 1 }); // server truth; Starter must survive as free
    expect(inv.owns("Orion")).toBe(false);
    expect(inv.count("Skull")).toBe(2);
    expect(inv.owns("Starter")).toBe(true);
    expect(grants.length).toBe(1); // hydrate fired no onGrant
  });
```

If the file's memory-storage helper is named differently (e.g. `memStorage`), use that name instead in the two calls above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/inventory.test.ts`
Expected: FAIL — the 4th `hooks` arg is ignored; `snapshot`/`hydrate` don't exist.

- [ ] **Step 3: Extend the interface**

In `src/core/inventory.ts`, in the `Inventory` interface (after `meltable(): { id: string; count: number }[];`, line 17), add:

```ts
  /** current counts as a plain object — the first-bind migration snapshot */
  snapshot(): Record<string, number>;
  /** replace all counts from a server snapshot; the free floor is re-applied. No hooks fired. */
  hydrate(counts: Record<string, number>): void;
```

- [ ] **Step 4: Add the `hooks` param + implement the methods**

In `src/core/inventory.ts`, change the signature (line 21):

```ts
export function createInventory(
  key: string,
  free: string[] = [],
  storage: Storage = localStorage,
  hooks: { onGrant?: (id: string, isNew: boolean) => void; onMelt?: (id: string, melted: boolean) => void } = {},
): Inventory {
```

Replace the returned `grant` and `melt` (lines 47-60) to fire hooks, and add `snapshot`/`hydrate`. The full `return` block becomes:

```ts
  return {
    owns: (id) => (counts.get(id) ?? 0) > 0,
    count: (id) => counts.get(id) ?? 0,
    grant: (id) => {
      const prev = counts.get(id) ?? 0;
      counts.set(id, prev + 1);
      persist();
      const isNew = prev === 0;
      hooks.onGrant?.(id, isNew);
      return isNew;
    },
    spares: (id) => Math.max(0, (counts.get(id) ?? 0) - 1),
    melt: (id) => {
      const prev = counts.get(id) ?? 0;
      if (prev <= 1) { hooks.onMelt?.(id, false); return false; } // keep the last copy
      counts.set(id, prev - 1);
      persist();
      hooks.onMelt?.(id, true);
      return true;
    },
    all: () => [...counts.entries()].filter(([, n]) => n > 0).map(([id]) => id),
    meltable: () => [...counts.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n })),
    snapshot: () => Object.fromEntries([...counts.entries()].filter(([, n]) => n > 0)),
    hydrate: (next) => {
      counts.clear();
      for (const [id, n] of Object.entries(next)) {
        const c = Math.max(0, Math.floor(Number(n) || 0));
        if (c > 0) counts.set(id, c);
      }
      for (const id of free) if ((counts.get(id) ?? 0) < 1) counts.set(id, 1); // free floor survives
      persist();
    },
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/core/inventory.test.ts`
Expected: PASS (all, including existing tests — the 4th arg is optional so prior calls are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/core/inventory.ts src/core/inventory.test.ts
git commit -m "feat(client): Inventory grant/melt hooks + hydrate + snapshot"
```

---

## Task 5: Expose `signMessage` on `GameSession`

**Files:**
- Modify: `src/chain/game-session.ts:23-42` (interface), `:140-141` (returned object)
- Modify: `src/chain/game-session.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/chain/game-session.test.ts` a focused test. Match the file's existing `createGameSession(...)` construction (it passes `mint`, `port`, and may accept `injectAddress`). Use a minimal fake port exposing `signMessage`:

```ts
  it("signMessage delegates to the wallet port", async () => {
    const signed = new Uint8Array([9, 8, 7]);
    const port = {
      currentAddress: () => "Addr",
      connect: async () => ({ address: "Addr" }),
      disconnect: async () => {},
      signMessage: async (_m: Uint8Array) => signed,
    };
    const session = createGameSession({ mint: new PublicKey(CHAIN.STAKE_MINT), onSettled: () => {}, port: port as any });
    expect(await session.signMessage(new TextEncoder().encode("hi"))).toEqual(signed);
  });
```

Adjust the imports (`PublicKey`, `CHAIN`, `createGameSession`) to match those already used at the top of `game-session.test.ts`. If the existing tests construct the session through a helper, reuse that helper and only add the `signMessage` assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chain/game-session.test.ts`
Expected: FAIL — `session.signMessage` is not a function.

- [ ] **Step 3: Add to the interface**

In `src/chain/game-session.ts`, in `export interface GameSession {`, add after `address(): string;` (line 24):

```ts
  /** sign a message with the connected wallet (server nonce-challenge binding). Throws if no wallet. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
```

- [ ] **Step 4: Implement it in the returned object**

In `src/chain/game-session.ts`, in the `return { ... }` (starting line 140), add after `address: () => opts.injectAddress ?? port?.currentAddress() ?? "",` (line 141):

```ts
    signMessage: (message) => {
      if (!port) throw new Error("no_wallet");
      return port.signMessage(message);
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/chain/game-session.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/chain/game-session.ts src/chain/game-session.test.ts
git commit -m "feat(chain): expose signMessage on GameSession for server bind"
```

---

## Task 6: `sign-in-sync.ts` — bind Privy → adopt session → hydrate

**Files:**
- Create: `src/core/sign-in-sync.ts`
- Create: `src/core/sign-in-sync.test.ts`

This extracts the sign-in orchestration into a pure, testable function (matching `core/wallet-binding.ts` / `core/wallet-connection.ts`) so `main.ts` stays a thin caller.

- [ ] **Step 1: Write the failing test**

Create `src/core/sign-in-sync.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { bindAndHydrate } from "./sign-in-sync";

describe("bindAndHydrate", () => {
  it("binds the wallet, adopts the session, then hydrates", async () => {
    const adoptSession = vi.fn();
    const hydrate = vi.fn(async () => "seeded" as const);
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "c", message: "sign me", wallet, expiresAt: "t" })),
      bindWallet: vi.fn(async () => ({ wallet: "Addr", token: "tok", userId: "uid" })),
    };
    const port = {
      connect: vi.fn(async () => ({ address: "Addr" })),
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    };

    const outcome = await bindAndHydrate({
      api, auth: { adoptSession },
      port,
      accountSync: { hydrate } as any,
      localSnapshot: { coins: 10, scrap: 2, cars: { orion: 1 } },
    });

    expect(api.bindWalletChallenge).toHaveBeenCalledWith("Addr");
    expect(adoptSession).toHaveBeenCalledWith({ token: "tok", userId: "uid" });
    expect(hydrate).toHaveBeenCalledWith({ coins: 10, scrap: 2, cars: { orion: 1 } });
    expect(outcome).toBe("seeded");
  });

  it("still hydrates when the bind returns no session token (dev/back-compat)", async () => {
    const adoptSession = vi.fn();
    const hydrate = vi.fn(async () => "server" as const);
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "c", message: "m", wallet, expiresAt: "t" })),
      bindWallet: vi.fn(async () => ({ wallet: "Addr" })), // no token/userId
    };
    const port = { connect: vi.fn(async () => ({ address: "Addr" })), signMessage: vi.fn(async () => new Uint8Array([1])) };

    const outcome = await bindAndHydrate({
      api, auth: { adoptSession }, port, accountSync: { hydrate } as any,
      localSnapshot: { coins: 0, scrap: 0, cars: {} },
    });
    expect(adoptSession).not.toHaveBeenCalled();
    expect(outcome).toBe("server");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/sign-in-sync.test.ts`
Expected: FAIL — `./sign-in-sync` does not exist.

- [ ] **Step 3: Write the orchestrator**

Create `src/core/sign-in-sync.ts`:

```ts
import type { Api } from "./api";
import type { AuthProvider } from "./auth";
import type { AccountSync, AccountSnapshot } from "./account-sync";
import type { SolanaWalletPort } from "./solana-wallet";
import { connectAndBindWallet } from "./wallet-binding";

/** On sign-in: bind the Privy wallet to the server (nonce challenge → session token), adopt that
 *  token into the auth provider, then hydrate coins/scrap/cars. Pure — `main.ts` supplies the port
 *  (a thin adapter over the live GameSession) and the local snapshot. */
export async function bindAndHydrate(input: {
  api: Pick<Api, "bindWalletChallenge" | "bindWallet">;
  auth: Pick<AuthProvider, "adoptSession">;
  port: Pick<SolanaWalletPort, "connect" | "signMessage">;
  accountSync: Pick<AccountSync, "hydrate">;
  localSnapshot: AccountSnapshot;
}): Promise<"seeded" | "server" | "offline"> {
  const bound = await connectAndBindWallet({ port: input.port as SolanaWalletPort, api: input.api });
  if (bound.session) input.auth.adoptSession?.(bound.session);
  return input.accountSync.hydrate(input.localSnapshot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/sign-in-sync.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/core/sign-in-sync.ts src/core/sign-in-sync.test.ts
git commit -m "feat(client): bindAndHydrate sign-in orchestrator"
```

---

## Task 7: Wire it into `main.ts`

**Files:**
- Modify: `src/main.ts` — imports; instantiate `auth`/`api`/`accountSync` before the stores; inject store hooks; a `syncAccount()` helper; call it on sign-in and boot reconnect; `disable()` on logout.

This task is glue — the logic it drives is all unit-tested (Tasks 1-6). It is verified in the browser in Task 8, not by a unit test.

- [ ] **Step 1: Add imports**

In `src/main.ts`, near the other `core/*` imports (e.g. beside line 30 `import { createInventory } from "./core/inventory";`), add:

```ts
import { createSessionAuth } from "./core/auth-session";
import { createApi } from "./core/api";
import { createAccountSync } from "./core/account-sync";
import { bindAndHydrate } from "./core/sign-in-sync";
```

- [ ] **Step 2: Instantiate auth + api + accountSync BEFORE the stores**

In `src/main.ts`, immediately **before** `const upgrades = createUpgrades(hudRoot, {` (line 265), insert:

```ts
// Server account: coins/scrap/cars live on @perps/server keyed by the Privy identity. The auth
// provider holds the wallet-bound session token; `api` talks to the server; `accountSync` reconciles
// on sign-in and forwards best-effort deltas. Guests never enable it (all forwarders no-op).
const auth = createSessionAuth();
const api = createApi({ auth });
const accountSync = createAccountSync({
  api,
  nonce: String(Date.now()), // stable per page load; namespaces this session's delta refs
  applyServer: (snap) => {
    upgrades.hydrate({ coins: snap.coins, scrap: snap.scrap });
    inventory.hydrate(snap.cars);
  },
});
```

(`applyServer` closes over `upgrades`/`inventory`, which are declared just below and on line 345; the closure only runs during `hydrate`, well after both exist.)

- [ ] **Step 3: Inject the coins/scrap hook into `createUpgrades`**

In `src/main.ts`, in the `createUpgrades(hudRoot, { ... })` opts (lines 265-271), add an `onMutate`:

```ts
  onMutate: (ev) => {
    if (ev.kind === "coinsEarn") accountSync.coinsEarned(ev.amount);
    else if (ev.kind === "coinsSpend") accountSync.coinsSpent(ev.amount);
    else if (ev.kind === "scrapEarn") accountSync.scrapEarned(ev.amount);
    else if (ev.kind === "scrapSpend") accountSync.scrapSpent(ev.amount);
  },
```

- [ ] **Step 4: Inject the grant/melt hook into the CAR inventory**

In `src/main.ts`, change the car-inventory line (345) to pass hooks (the `levels` inventory on 347 stays hook-less — world skins are local-only this slice):

```ts
const inventory = createInventory("redline.owned.v1", ["Starter"], localStorage, {
  onGrant: (id) => accountSync.carGranted(id),
  onMelt: (id) => accountSync.carMelted(id),
}); // Starter is free; other cars pull from crates
```

- [ ] **Step 5: Add a `syncAccount()` helper and call it on sign-in**

In `src/main.ts`, just after the `ensureSignedIn` function (after line 186), add:

```ts
// Bind the Privy identity to the server and pull coins/scrap/cars. Offline/failure → the game keeps
// running on the local cache; the next successful sign-in reconciles (server wins).
async function syncAccount(): Promise<void> {
  try {
    const port = {
      connect: async () => ({ address: session.address() }),
      signMessage: (m: Uint8Array) => session.signMessage(m),
    };
    await bindAndHydrate({
      api, auth, port, accountSync,
      localSnapshot: { coins: upgrades.coins(), scrap: upgrades.scrap(), cars: inventory.snapshot() },
    });
  } catch (e) {
    console.error("account sync failed", e); // cache-only until next sign-in
  }
}
```

Then, inside `ensureSignedIn`, after `signedIn = true;` (line 172) and before `void syncTableCap();` (line 173), add:

```ts
    await syncAccount();
```

- [ ] **Step 6: Sync on the boot reconnect for returning signed-in players**

In `src/main.ts`, change the boot reconnect (line 1444) so a silently-restored session also hydrates:

```ts
  void session.reconnect().then((ok) => { if (ok) { signedIn = true; syncOnchainBalance(); void syncTableCap(); void syncAccount(); } }).catch(() => {});
```

- [ ] **Step 7: Disable on logout**

In `src/main.ts`, at the logout site where `signedIn = false; identity = null;` (lines 404-405), add right after:

```ts
      accountSync.disable();
      void auth.logout?.();
```

- [ ] **Step 8: Typecheck**

Run: `npm run build`
Expected: `tsc` clean, Vite build succeeds. If `tsc` flags the `createInventory` 4th arg on the `levels` call (347), leave it — that call is unchanged and the arg is optional.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "feat(client): wire coins/scrap/cars through the server on sign-in"
```

---

## Task 8: Full suite, typecheck, and browser verification

**Files:** none (verification only).

- [ ] **Step 1: Full client test suite**

Run: `npx vitest run`
Expected: all PASS (the new + all existing tests).

- [ ] **Step 2: Typecheck + build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Server up + client up, verify the loop in Claude Preview**

Start the local soft-coin server (`@perps/server`) and the client dev server (see `.claude/launch.json`). Then, per the memory rule *"verify UI in browser before done"*, in Claude Preview:

- [ ] **Sign in** via the identity gate (Privy). Confirm the console shows no `account sync failed`.
- [ ] **Earn coins** — drive and collect pickups (or trigger a crate). The coins chip rises. Confirm `POST /v1/coins/earn` fires in the network panel.
- [ ] **Earn scrap** — collect a junk-metal heap. Confirm `POST /v1/scrap/earn`.
- [ ] **Pull a car from a crate.** Confirm `POST /v1/inventory/grant` and the car appears in the garage.
- [ ] **Reload the page.** On sign-in the balances/cars come back from the server: confirm `GET /v1/me` returns the earned totals and the HUD matches (not the pre-earn numbers).
- [ ] **First-bind seed:** in a fresh browser profile, play as a guest (earn coins), then sign in. Confirm `POST /v1/migrate` fires and returns `{seeded:true}`, and the server now holds the guest's coins (subsequent `/v1/me` matches).
- [ ] **Server-wins:** with an account that already has server state, load in a second browser with empty localStorage. Confirm `/v1/me` hydrates it and NO `/v1/migrate` fires (no double-credit).
- [ ] **Offline resilience:** stop the server, keep playing. Confirm no crash and coins still move locally; restart the server, reload → `/v1/me` reconciles.

- [ ] **Step 4: Deliver the on-device checklist note**

Capture the above as the desktop portion of the cross-device checklist the spec calls for (iPhone PWA + Seeker APK portions belong to Plan 3). Add it to the plan's verification section or a short `docs/` note.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(client): account-sync browser verification + checklist"
```

---

## Self-Review

**Spec coverage** (against `2026-07-07-crossplatform-privy-account-design.md`, Workstream B):
- B1 *Auth wiring — hold the wallet-bound session token in the client:* Tasks 5, 6, 7 (`signMessage` → `bindAndHydrate` → `auth.adoptSession`).
- B2 *Scrap ledger asset:* server-side, done in Plan 1; consumed by Task 1's `scrapEarn/scrapSpend`.
- B3 *Counted inventory grant/melt:* server-side Plan 1; consumed by Task 1's `inventoryGrant/inventoryMelt` + Task 4 hooks.
- B4 *Client rewiring through `core/api.ts` with localStorage as cache:* Tasks 2, 3, 4, 7.
- B5 *First-bind migration, seed-if-empty, never wipe/never sum:* Task 2 `hydrate` ("seeded" vs "server" branches) + Task 8 verification.
- B6 *Offline / server-down keeps playing, reconcile on reconnect:* Task 2 (best-effort `fire`, `me()` failure → "offline") + Task 8 offline check.
- *Sync semantics — deltas not absolutes:* Task 2 forwarders POST `{amount}` deltas; absolute totals are never sent except the one-time migrate seed.
- *Deferred (explicit):* upgrade levels, finishes, world skins stay local — the server (Plan 1) has no columns for them. Flagged in the Scope note; not a gap.

**Placeholder scan:** none — every code step carries the actual code; every run step has an exact command + expected result. Task 8 is verification-only by design (glue in `main.ts` is exercised in the browser, its logic unit-tested in Tasks 1-6).

**Type consistency:**
- `AccountSnapshot { coins, scrap, cars: Record<string,number> }` — defined in Task 2, consumed identically in Tasks 6 (`localSnapshot`) and 7 (`inventory.snapshot()` returns `Record<string,number>`; `applyServer` maps `me.cars` → the same shape).
- `Upgrades.hydrate({coins,scrap})` (Task 3) matches `applyServer`'s call in Task 7.
- `Inventory.hydrate(counts)` + `snapshot()` (Task 4) match Task 7's `inventory.hydrate(snap.cars)` and `inventory.snapshot()`.
- `onMutate` event kinds (`coinsEarn|coinsSpend|scrapEarn|scrapSpend`) are identical in the `Upgrades` opt (Task 3) and the `main.ts` handler (Task 7).
- `bindAndHydrate` return `"seeded"|"server"|"offline"` matches `AccountSync.hydrate`'s return (Tasks 2, 6).
- Api method names (`coinsEarn/coinsSpend/scrapEarn/scrapSpend/inventoryGrant/inventoryMelt/migrate`) are defined in Task 1 and called under those exact names in Task 2.

**Risk notes for the executor:**
- The `port` adapter in Task 7 reuses the already-connected `session` (no re-`connect()` prompt) — `connect: async () => ({ address: session.address() })` returns the live address; `connectAndBindWallet` only reads `connected.address` and calls `signMessage`. Confirm `session.address()` is populated at sign-in time (it is — `ensureSignedIn` sets `signedIn` after `session.init()/loginFresh()` resolves the address).
- `createSessionAuth` lazily POSTs `/v1/session` only on first `authHeaders()`. Because `accountSync` is disabled until `hydrate`, and `hydrate` runs only after `adoptSession`, the anon-session path is never hit for a wallet-bound player — the Bearer token is always the wallet-bound one.
- If `game-session.test.ts` builds sessions through a shared helper/fake, adapt Task 5's test to that helper rather than hand-rolling a port.
