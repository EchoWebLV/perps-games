import type { PriceFeed, PriceTick } from "./types.js";

const HERMES_LATEST = "https://hermes.pyth.network/v2/updates/price/latest";

// Pyth price-feed ids (same set the client uses in main.ts ASSETS).
const FEED_IDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

export interface HermesOpts {
  assets: string[];
  pollMs?: number; // default 500
  staleMs?: number; // HALT threshold, default 4000
}

export function makeHermesFeed(opts: HermesOpts): PriceFeed {
  const pollMs = opts.pollMs ?? 500;
  const staleMs = opts.staleMs ?? 4000;
  const last: Record<string, PriceTick> = {};
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tickOnce(): Promise<void> {
    const query = opts.assets
      .filter((a) => FEED_IDS[a])
      .map((a) => `ids[]=${FEED_IDS[a]}`)
      .join("&");
    const res = await fetch(`${HERMES_LATEST}?${query}&parsed=true`);
    if (!res.ok) return;
    const json = (await res.json()) as { parsed?: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }> };
    for (const p of json.parsed ?? []) {
      const asset = opts.assets.find((a) => FEED_IDS[a] === p.id || FEED_IDS[a] === p.id.replace(/^0x/, ""));
      if (!asset) continue;
      const price = parseFloat(p.price.price) * Math.pow(10, p.price.expo);
      const tsUs = p.price.publish_time * 1_000_000; // publish_time is whole seconds
      // VALIDATE before it can ever touch money: positive, finite, monotonic ts.
      if (!Number.isFinite(price) || !(price > 0)) continue;
      const prev = last[asset];
      if (prev && tsUs < prev.tsUs) continue;
      last[asset] = { price, tsUs };
    }
  }

  return {
    current(asset) {
      const t = last[asset];
      if (!t) throw new Error(`no tick for ${asset}`);
      return t;
    },
    healthy(asset) {
      const t = last[asset];
      if (!t) return false;
      // fresh enough by oracle ts (publish_time is coarse; staleMs absorbs the ±1s)
      return Date.now() * 1000 - t.tsUs < staleMs * 1000;
    },
    start() {
      void tickOnce();
      timer = setInterval(() => void tickOnce().catch(() => {}), pollMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
