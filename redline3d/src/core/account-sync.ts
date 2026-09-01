import type { Api } from "./api";

/** the player's soft account state, mirrored between the local cache and the server ledger. */
export interface AccountSnapshot {
  coins: number;
  scrap: number;
  cars: Record<string, number>; // carId -> count owned
  /** garage upgrade levels. OPTIONAL on the read path: a deployed server predating the
   *  upgrades feature omits it, and server-wins must not zero a player's local tree. */
  levels?: { turbo: number; tank: number; suspension: number };
}

export interface AccountSync {
  /** true once a signed-in session has hydrated; forwarders no-op until then (guests stay local). */
  enabled(): boolean;
  /** On sign-in: reconcile local vs server. Server EMPTY + local has state → SEED the server from
   *  local (first-bind migration). Otherwise the server is authoritative and its snapshot is written
   *  back into the local cache via `applyServer` (never summed). Offline/guest → disabled, cache-only. */
  hydrate(local: AccountSnapshot): Promise<"seeded" | "server" | "offline">;
  /** the access-code ids this account has redeemed server-side, as of the last hydrate. Empty before
   *  hydrate and for guests — the account-level access wall reads this to decide whether to show. */
  accessCodes(): string[];
  /** Railway-backed social display name, or null until the account has chosen one. */
  driverName(): string | null;
  /** drop server authority (logout / account switch); forwarders no-op again. */
  disable(): void;
  /** Wait until every account mutation already started by this page has reached Railway.
   * Reload and logout boundaries must await this or the browser can abort the writes. */
  flush(): Promise<void>;
  coinsEarned(n: number): void;
  coinsSpent(n: number): void;
  scrapEarned(n: number): void;
  scrapSpent(n: number): void;
  carGranted(carId: string): void;
  carMelted(carId: string): void;
  /** forward an upgrade purchase to the authoritative /v1/upgrades/buy (which debits coins
   *  and scrap server-side — never paired with coinsSpent/scrapSpent for the same purchase). */
  levelBought(track: "turbo" | "tank" | "suspension"): void;
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
  let writeFailure: { where: string; error: unknown } | null = null;
  const pending = new Set<Promise<void>>();
  let access: string[] = []; // the account's redeemed access-code ids, refreshed on each hydrate
  let profileName: string | null = null;
  const ref = (kind: string) => `${opts.nonce}:${kind}:${seq++}`;
  const swallow = (where: string) => (err: unknown) => opts.onError?.(where, err);
  // Mutations remain non-blocking during play, but every promise is retained so destructive page
  // boundaries can wait for Railway. A rejected write is remembered: reloading after one would let
  // the older server snapshot overwrite newer local progress on the next login.
  const fire = (where: string, p: Promise<unknown> | undefined) => {
    if (!p) return;
    let tracked!: Promise<void>;
    tracked = p.then(() => undefined).catch((error) => {
      writeFailure = { where, error };
      swallow(where)(error);
    }).finally(() => { pending.delete(tracked); });
    pending.add(tracked);
  };

  return {
    enabled: () => on,
    accessCodes: () => access,
    driverName: () => profileName,
    disable: () => { on = false; access = []; profileName = null; },
    async flush() {
      // New writes can be added while an earlier batch settles, so drain until stable.
      while (pending.size > 0) await Promise.all([...pending]);
      if (writeFailure) throw new Error(`account_save_failed:${writeFailure.where}`);
    },

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
      access = me.access ?? []; // surface the account's redeemed codes for the access wall (default [])
      profileName = me.driverName ?? null;
      writeFailure = null;
      // Mirrors the server's /v1/migrate emptiness semantics: any non-zero level blocks seeding
      // (missing levels — an old server — counts as all-zero).
      const serverEmpty = (me.coins ?? 0) === 0 && (me.scrap ?? 0) === 0 && (me.cars?.length ?? 0) === 0
        && (me.levels?.turbo ?? 0) === 0 && (me.levels?.tank ?? 0) === 0 && (me.levels?.suspension ?? 0) === 0;
      const localHasState = local.coins > 0 || local.scrap > 0 || Object.keys(local.cars).length > 0
        || (!!local.levels && (local.levels.turbo > 0 || local.levels.tank > 0 || local.levels.suspension > 0));
      if (serverEmpty && localHasState) {
        try {
          await api.migrate({ coins: local.coins, scrap: local.scrap, cars: local.cars, levels: local.levels });
          opts.applyServer(local); // a vault-backed migration must become the live UI immediately
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
        levels: me.levels, // pass through as-is: undefined (old server) → the cache keeps its local tree
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
    levelBought(track) { if (on && opts.api) fire("upgradesBuy", opts.api.upgradesBuy({ track })); },
  };
}
