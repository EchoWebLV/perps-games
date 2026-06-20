export interface Quality {
  tier: "low" | "high";
  bloom: boolean;
  /** bloom internal-resolution scale — lower = cheaper blur passes on weak GPUs */
  bloomScale: number;
  pixelRatioCap: number;
}

export function detectQuality(): Quality {
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const low = mem <= 3 || cores <= 4;
  // Bloom is the game's signature neon glow — and most of its perceived brightness.
  // We want phones to look IDENTICAL to desktop, so bloom runs at full resolution on
  // every device (bloomScale 1). The only tier concession left is a slightly lower
  // pixel-ratio cap on weak GPUs, which affects sharpness — not the glow or brightness.
  // (If a low-end device ever struggles, drop bloomScale to 0.5 on the `low` path —
  //  the scene keeps the glow, just with a cheaper blur chain.)
  return { tier: low ? "low" : "high", bloom: true, bloomScale: 1, pixelRatioCap: low ? 1.5 : 2 };
}
