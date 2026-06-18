export interface PriceTransport {
  /** subscribe to real prices; return an unsubscribe fn */
  connect: (onPrice: (price: number) => void) => () => void;
  staleMs?: number;
  simSeed?: number;
}

export interface PriceSource {
  price(): number;
  live(): boolean;
  stop(): void;
}

export function createPriceSource(t: PriceTransport): PriceSource {
  const staleMs = t.staleMs ?? 2500;
  let target = t.simSeed ?? 0;
  let last = 0; // timestamp of last real tick
  const now = () => Date.now();

  const unsub = t.connect((p) => {
    if (p > 0) {
      target = p;
      last = now();
    }
  });

  // sim drift + staleness backstop (mirrors prototype redline.html line 143)
  const sim = setInterval(() => {
    if (now() - last > staleMs) {
      if (!target) target = 172;
      target = Math.max(1, target * (1 + (Math.random() - 0.5) * 0.0018));
    }
  }, 200);

  return {
    price: () => target,
    live: () => now() - last <= staleMs && last > 0,
    stop: () => {
      clearInterval(sim);
      unsub();
    },
  };
}
