import { CONFIG } from "./config";

const { RMIN, RMAX } = CONFIG;

/** position of leverage l on a log scale, 0 at RMIN, 1 at RMAX */
export function levFrac(l: number): number {
  return Math.log(l / RMIN) / Math.log(RMAX / RMIN);
}

/** throttle 0..100 → leverage on a log curve */
export function tToLev(t: number): number {
  return RMIN * Math.pow(RMAX / RMIN, t / 100);
}

/** snap a raw leverage to a "nice" discrete value */
export function niceLev(l: number): number {
  if (l < 100) return Math.round(l / 5) * 5;
  if (l < 500) return Math.round(l / 10) * 10;
  return Math.round(l / 50) * 50;
}
