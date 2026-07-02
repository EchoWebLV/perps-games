/** Highway mode's speed→leverage ladder. Gear g is active while speedFrac sits in
 *  [g/N, (g+1)/N); HYST widens each boundary so leverage doesn't flicker (every gear
 *  change is a real on-chain lever = a rebank). 10 is the program's leverage floor;
 *  100 is this mode's cap — regardless of car or upgrades. */
export const GEARS = [10, 20, 35, 50, 75, 100] as const;
export const HW_MAX_LEV = GEARS[GEARS.length - 1];
const N = GEARS.length;
const HYST = 0.035;

const clampGear = (g: number) => Math.max(0, Math.min(N - 1, Math.floor(g)));

/** next gear given the current gear and |speed|/MAX_FWD ∈ [0,1] — hysteresis both ways */
export function shiftGear(cur: number, speedFrac: number): number {
  let g = clampGear(cur);
  const f = Math.max(0, Math.min(1, speedFrac));
  while (g < N - 1 && f >= (g + 1) / N + HYST) g++;
  while (g > 0 && f < g / N - HYST) g--;
  return g;
}

export const levOf = (gear: number): number => GEARS[clampGear(gear)];
