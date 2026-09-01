/**
 * The tradable symbol table. ONE place the whole server learns what it can price.
 *
 * Pyth price-feed ids (same set the client uses in main.ts ASSETS). Every server-side surface that
 * needs to know which assets exist derives from this table rather than carrying its own copy — the
 * Hermes subscription, the `/v1/feed` fan-out, the `/v1/prices` poll rail, the round/trade zod
 * enums, the presence highway frame and `TradeAsset` — so adding a row here is the whole job.
 */
export interface FeedSymbol {
  /** Pyth Hermes price-feed id, 64 lowercase hex chars, no 0x prefix. */
  hermesId: string;
  /** Ticker as shown to players. */
  display: string;
}

// Deliberately NOT annotated `Record<string, FeedSymbol>`: `satisfies` keeps the literal keys, and
// the literal keys are what every derived enum below is built from.
export const FEED_SYMBOLS = {
  BTC: { hermesId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", display: "BTC" },
  ETH: { hermesId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", display: "ETH" },
  SOL: { hermesId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", display: "SOL" },
} satisfies Record<string, FeedSymbol>;

/** Every tradable key as a literal union — the type every server-side asset enum resolves to. */
export type FeedAssetKey = keyof typeof FEED_SYMBOLS;

/**
 * The table's keys in declaration order, typed as the non-empty tuple `z.enum` demands.
 * `Object.keys` can only promise `string[]`, so the tuple shape is asserted; the table is a
 * non-empty object literal, which makes the assertion sound. The element type is still derived,
 * so a new row widens every `z.enum(FEED_ASSET_KEYS)` at both type and runtime level.
 */
export const FEED_ASSET_KEYS = Object.keys(FEED_SYMBOLS) as unknown as readonly [FeedAssetKey, ...FeedAssetKey[]];

/** Every symbol key, in table order — the canonical asset list for feed + fan-out wiring. */
export function feedAssetKeys(): string[] {
  return [...FEED_ASSET_KEYS];
}

/** Hermes id for a symbol key, or undefined if it isn't tradable. */
export function hermesIdOf(key: string): string | undefined {
  return (FEED_SYMBOLS as Record<string, FeedSymbol>)[key]?.hermesId;
}
