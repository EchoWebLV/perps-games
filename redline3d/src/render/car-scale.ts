// Shared car-footprint sizing. Every car GLB is normalized by LENGTH — its longest
// horizontal bbox axis is scaled to a fixed road footprint — which alone leaves boxy/tall
// models (slot machine, skull) reading ~2× the visual mass of flat sports cars at the same
// length. This adds a partial VOLUME correction on top of the length basis: measure the mass
// the length-normalization would render (cbrt of the scaled bbox volume) and nudge every car
// toward the roster-median mass, clamped so length never drifts absurdly. The Box3 the caller
// already built is the only input, so no extra geometry pass.
//
// The correction is deliberately computed on the FINAL size INCLUDING the per-car mul, so the
// hand-tuned multipliers (shopping cart small, RV long) keep their intended look — only genuine
// outliers move, and a car already at the median is returned at its plain length-normalized
// scale untouched.

export const REF_LEN = 11.23;   // road footprint all sizing sites are calibrated against
export const MASS_TARGET = 6.9; // cbrt(bbox volume) a car should read as at REF_LEN (roster median)
export const MASS_EXP = 0.5;    // 0 = legacy pure-length normalize · 1 = full equal-volume
export const CORR_MIN = 0.8;    // never shrink a car below 80% of its length-normalized size
export const CORR_MAX = 1.15;   // never grow one past 115%

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The uniform scale to apply to a length-normalized car so its visual mass reads closer to the
 * roster median. `size` is the model's pre-scale bounding-box extents, `targetLen` the site's
 * footprint (11.23 on the road, 8.6 on the garage turntable), `mul` the per-car footprint tweak.
 *
 * Returns the LEGACY scalar `(targetLen / max(size.x,size.z)) * mul` multiplied by a clamped
 * volume correction. With MASS_EXP = 0 the correction is 1 and this is exactly the legacy
 * formula; MASS_EXP = 0.5 applies a gentle square-root pull toward MASS_TARGET.
 */
export function carNormScale(size: { x: number; y: number; z: number }, targetLen: number, mul = 1): number {
  // legacy length normalization (unchanged basis): longest horizontal axis → footprint × mul
  const sLen = (targetLen / (Math.max(size.x, size.z) || 1)) * mul;
  // mass this scale would render: cbrt of the scaled bbox volume. Guard degenerate/negative
  // volume (a zero-size or malformed model) → no correction, so the result stays finite.
  const vol = size.x * size.y * size.z;
  const mass = Math.cbrt(vol) * sLen;
  // scale the median target with the site footprint so an 8.6 turntable corrects identically to
  // the 11.23 road (the targetLen cancels in target/mass → same correction, only base differs).
  const target = MASS_TARGET * (targetLen / REF_LEN);
  const corr = vol > 0 ? clamp((target / mass) ** MASS_EXP, CORR_MIN, CORR_MAX) : 1;
  return sLen * corr;
}
