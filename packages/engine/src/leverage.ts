import { CONFIG } from "./config";

// read CONFIG live (not destructured) so the Turbo Kit's runtime RMAX bump takes effect

/** position of leverage l on a log scale, 0 at RMIN, 1 at RMAX */
export function levFrac(l: number): number {
  return Math.log(l / CONFIG.RMIN) / Math.log(CONFIG.RMAX / CONFIG.RMIN);
}

/** throttle 0..100 → leverage on a log curve */
export function tToLev(t: number): number {
  return CONFIG.RMIN * Math.pow(CONFIG.RMAX / CONFIG.RMIN, t / 100);
}

/** snap a raw leverage to a "nice" discrete value */
export function niceLev(l: number): number {
  if (l < 100) return Math.round(l / 5) * 5;
  if (l < 500) return Math.round(l / 10) * 10;
  return Math.round(l / 50) * 50;
}
