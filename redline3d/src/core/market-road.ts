export interface TerrainBiasInput {
  smoothPrice: number;
  emaPrice: number;
  momentum: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function terrainBias(input: TerrainBiasInput): number {
  const displacement = input.smoothPrice > 0 && input.emaPrice > 0
    ? clamp((input.smoothPrice / input.emaPrice - 1) * 2600, -7, 7) * 0.45
    : 0;
  const momentum = clamp(input.momentum, -1, 1) * 5.5;
  return clamp(displacement + momentum, -7, 7);
}
