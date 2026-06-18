export interface Quality {
  tier: "low" | "high";
  bloom: boolean;
  pixelRatioCap: number;
}

export function detectQuality(): Quality {
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const low = mem <= 3 || cores <= 4;
  return { tier: low ? "low" : "high", bloom: !low, pixelRatioCap: low ? 1.5 : 2 };
}
