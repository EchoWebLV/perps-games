export interface TerrainGradeInput {
  smoothPrice: number;
  emaPrice: number;
  momentum: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const MAX_ROAD_GRADE_DEG = 8;
export const ROAD_GRADE_ANCHOR_Z = -12;

export function terrainGrade(input: TerrainGradeInput): number {
  const displacement = input.smoothPrice > 0 && input.emaPrice > 0
    ? clamp((input.smoothPrice / input.emaPrice - 1) * 2600, -MAX_ROAD_GRADE_DEG, MAX_ROAD_GRADE_DEG) * 0.5
    : 0;
  const momentum = clamp(input.momentum, -1, 1) * MAX_ROAD_GRADE_DEG;
  return clamp(displacement + momentum, -MAX_ROAD_GRADE_DEG, MAX_ROAD_GRADE_DEG);
}

export function roadGradeSlope(gradeDegrees: number): number {
  const safeGrade = clamp(Number.isFinite(gradeDegrees) ? gradeDegrees : 0, -MAX_ROAD_GRADE_DEG, MAX_ROAD_GRADE_DEG);
  return Math.tan(safeGrade * Math.PI / 180);
}

export function roadGradeOffset(worldZ: number, slope: number, anchorZ = ROAD_GRADE_ANCHOR_Z): number {
  return (anchorZ - worldZ) * slope;
}
