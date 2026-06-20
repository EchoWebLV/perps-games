import type { PriceFeed, PriceTick } from "./types.js";

/** Deterministic in-memory feed for tests. Drive it with set()/setHealthy(). */
export interface StubFeed extends PriceFeed {
  set(asset: string, tick: PriceTick): void;
  setHealthy(asset: string, ok: boolean): void;
}

export function makeStubFeed(initial: Record<string, PriceTick> = {}): StubFeed {
  const last: Record<string, PriceTick> = { ...initial };
  const forcedHealth: Record<string, boolean> = {};

  return {
    current(asset) {
      const t = last[asset];
      if (!t) throw new Error(`no tick for ${asset}`);
      return t;
    },
    healthy(asset) {
      if (asset in forcedHealth) return forcedHealth[asset];
      return asset in last;
    },
    set(asset, tick) {
      last[asset] = tick;
    },
    setHealthy(asset, ok) {
      forcedHealth[asset] = ok;
    },
    start() {},
    stop() {},
  };
}
