import { CONFIG } from "./config";

// read CONFIG live (not destructured) so the Turbo Kit's runtime RMAX bump takes effect.
// `rmax` is overridable so a car with a higher base leverage (e.g. the Cybertruck's 1500) can
// rescale the curve above the upgrade-driven CONFIG.RMAX without mutating the shared global.

/** position of leverage l on a log scale, 0 at RMIN, 1 at rmax (default CONFIG.RMAX) */
export function levFrac(l: number, rmax: number = CONFIG.RMAX): number {
  return Math.log(l / CONFIG.RMIN) / Math.log(rmax / CONFIG.RMIN);
}

/** throttle 0..100 → leverage on a log curve, topping out at rmax (default CONFIG.RMAX) */
export function tToLev(t: number, rmax: number = CONFIG.RMAX): number {
  return CONFIG.RMIN * Math.pow(rmax / CONFIG.RMIN, t / 100);
}

/** snap a raw leverage to a "nice" discrete value */
export function niceLev(l: number): number {
  if (l < 100) return Math.round(l / 5) * 5;
  if (l < 500) return Math.round(l / 10) * 10;
  return Math.round(l / 50) * 50;
}
