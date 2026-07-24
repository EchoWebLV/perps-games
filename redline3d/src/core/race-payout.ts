// Demo race economy — the single config the spec promises. Rake is shared with the
// bet panel (import from here, never redeclare). Owners of the top-3 finishers split
// a fixed slice of the rake, so the house keeps the rest and can never lose.
export const RAKE = 0.05;                    // fraction of the betting pool
export const OWNER_POOL_SHARE = 0.4;         // fraction of the rake paid to owners
export const PODIUM_SPLIT = [0.5, 0.3, 0.2]; // 1st / 2nd / 3rd of the owner pool

/** What the OWNER of the car finishing at `rank` (0-based) earns from a betting pool. */
export function ownerPodiumPayout(poolTotal: number, rank: number): number {
  const share = PODIUM_SPLIT[rank] ?? 0;
  return Math.round(poolTotal * RAKE * OWNER_POOL_SHARE * share * 100) / 100;
}
