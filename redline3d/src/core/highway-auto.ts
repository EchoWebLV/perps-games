import { LEN, TRACK, sample } from "./track";

export const HIGHWAY_MIN_LEV = 10;
export const HIGHWAY_MAX_LEV = 250;
export const HIGHWAY_LEV_STEP = 10;

const MIN_SPEED = 38;
const MAX_SPEED = 128;

export interface HighwayMotion {
  s: number;
  dir: 1 | -1;
  lane: number;
}

export interface HighwayPose {
  x: number;
  z: number;
  heading: number;
}

export function snapHighwayLeverage(value: number): number {
  const snapped = Math.round(value / HIGHWAY_LEV_STEP) * HIGHWAY_LEV_STEP;
  return Math.max(HIGHWAY_MIN_LEV, Math.min(HIGHWAY_MAX_LEV, snapped));
}

export function speedForLeverage(lev: number): number {
  const t = (snapHighwayLeverage(lev) - HIGHWAY_MIN_LEV) / (HIGHWAY_MAX_LEV - HIGHWAY_MIN_LEV);
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.sqrt(t);
}

export function seedHighwayMotion(seed: string, dir: 1 | -1): HighwayMotion {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const unsigned = hash >>> 0;
  return {
    s: (unsigned / 0xffffffff) * LEN,
    dir,
    lane: unsigned % TRACK.LANES,
  };
}

export function stepHighwayMotion(state: HighwayMotion, lev: number, dt: number): HighwayMotion {
  return {
    ...state,
    s: state.s + state.dir * speedForLeverage(lev) * Math.max(0, dt),
  };
}

export function highwayPose(state: HighwayMotion): HighwayPose {
  const center = sample(state.s);
  const lateral = state.dir * (TRACK.MEDIAN_HALF + TRACK.LANE_W * (state.lane + 0.5));
  const rightX = Math.cos(center.heading);
  const rightZ = Math.sin(center.heading);
  return {
    x: center.x + rightX * lateral,
    z: center.z + rightZ * lateral,
    heading: state.dir === 1 ? center.heading : center.heading + Math.PI,
  };
}
