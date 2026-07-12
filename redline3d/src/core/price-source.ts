export interface PriceTransport {
  /** subscribe to real prices; return an unsubscribe fn */
  connect: (onPrice: (price: number) => void) => () => void;
  staleMs?: number;
  simSeed?: number;
}

export interface PriceSource {
  price(): number;
  live(): boolean;
  /** Replace the current asset atomically. A cached real price becomes live immediately;
   *  null clears the previous asset and blocks money rounds until its first tick. */
  switchTo(realPrice: number | null): void;
  stop(): void;
  /** Re-subscribe after a suspend (bfcache restore): resumes real ticks AND forces live()=false
   *  until a fresh real tick lands. Without the reset, a page restored within the stale window
   *  would still read live() true on a frozen price and let a money round open on it. */
  restart(): void;
}

export function createPriceSource(t: PriceTransport): PriceSource {
  const staleMs = t.staleMs ?? 2500;
  let target = t.simSeed ?? 0;
  let last = 0; // timestamp of last real tick
  const now = () => Date.now();
  let unsub: (() => void) | null = null;
  let sim: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (sim) { clearInterval(sim); sim = null; }
    if (unsub) { unsub(); unsub = null; }
  }

  function start(): void {
    stop(); // idempotent — never stack two subscriptions / sim intervals
    last = 0; // a fresh subscription is NOT live until a real tick arrives (bfcache-frozen guard)
    unsub = t.connect((p) => {
      if (p > 0) {
        target = p;
        last = now();
      }
    });
    // sim drift + staleness backstop (mirrors prototype redline.html line 143)
    sim = setInterval(() => {
      if (now() - last > staleMs) {
        if (!target) target = 172;
        target = Math.max(1, target * (1 + (Math.random() - 0.5) * 0.0018));
      }
    }, 200);
  }

  start();

  return {
    price: () => target,
    live: () => now() - last <= staleMs && last > 0,
    switchTo: (realPrice) => {
      if (realPrice !== null && Number.isFinite(realPrice) && realPrice > 0) {
        target = realPrice;
        last = now();
      } else {
        target = 0;
        last = 0;
      }
    },
    stop,
    restart: () => { stop(); start(); },
  };
}
