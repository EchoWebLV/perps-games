/**
 * The tradable symbol table. ONE place the whole server learns what it can price.
 *
 * Pyth price-feed ids (same set the client uses in main.ts ASSETS). Adding an equity later is
 * literally adding a row here — the Hermes query, the `/v1/feed` fan-out and the round validator
 * all read this table rather than carrying their own copies.
 */
export interface FeedSymbol {
  /** Pyth Hermes price-feed id, 64 lowercase hex chars, no 0x prefix. */
  hermesId: string;
  /** Ticker as shown to players. */
  display: string;
}

export const FEED_SYMBOLS: Record<string, FeedSymbol> = {
  BTC: { hermesId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", display: "BTC" },
  ETH: { hermesId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", display: "ETH" },
  SOL: { hermesId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", display: "SOL" },
};

/** Every symbol key, in table order — the canonical asset list for feed + fan-out wiring. */
export function feedAssetKeys(): string[] {
  return Object.keys(FEED_SYMBOLS);
}

/** Hermes id for a symbol key, or undefined if it isn't tradable. */
export function hermesIdOf(key: string): string | undefined {
  return FEED_SYMBOLS[key]?.hermesId;
}
