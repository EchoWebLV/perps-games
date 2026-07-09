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
  /** the access-code ids this account has redeemed server-side, as of the last hydrate. Empty before
   *  hydrate and for guests — the account-level access wall reads this to decide whether to show. */
  accessCodes(): string[];
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
  let access: string[] = []; // the account's redeemed access-code ids, refreshed on each hydrate
  const ref = (kind: string) => `${opts.nonce}:${kind}:${seq++}`;
  const swallow = (where: string) => (err: unknown) => opts.onError?.(where, err);
  // Best-effort fire-and-forget: the local cache already updated the UI, so a failed server write
  // reconciles on the next sign-in load (server wins). Never throws into the caller.
  const fire = (where: string, p: Promise<unknown> | undefined) => { void p?.catch(swallow(where)); };

  return {
    enabled: () => on,
    accessCodes: () => access,
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
      access = me.access ?? []; // surface the account's redeemed codes for the access wall (default [])
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
