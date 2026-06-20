/** A single authoritative price observation. tsUs = oracle timestamp in microseconds. */
export interface PriceTick {
  price: number;
  tsUs: number;
}

export interface PriceFeed {
  /** latest authoritative tick for the asset; throws if none has arrived */
  current(asset: string): PriceTick;
  /** watchdog: true iff the feed for this asset is fresh enough to settle on */
  healthy(asset: string): boolean;
  start(): void;
  stop(): void;
}
