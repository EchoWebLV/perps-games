/** Fire when ≤10% of the margin to liquidation remains — the same altitude Skull's
 * near-death sequence arms at, high enough that the flip tx can land before the
 * on-chain mark crosses the floor (a too-late swerve still liquidates, terminal-first). */
export const SWERVE_BUFFER = 0.10;

/**
 * Pure trigger for the Helmet's "Auto-Swerve" — once per round, at the edge of
 * liquidation, flip the bet instead of dying (stop-and-reverse; the loss stays
 * banked by the flip's rebank). No DOM, unit-testable; main.ts feeds it the live
 * liq buffer each frame and fires the flip on the single `true`.
 */
export function createSwerveCore() {
  let enabled = false, live = false, used = false;
  return {
    get used() { return used; },
    setEnabled(on: boolean) { enabled = on; if (!on) used = false; },
    /** feed each frame; true exactly once per round, at the moment to swerve */
    update(isLive: boolean, buffer: number): boolean {
      if (!isLive) { if (live) used = false; live = false; return false; } // round over → re-arm
      live = true;
      if (!enabled || used || buffer > SWERVE_BUFFER) return false;
      used = true;
      return true;
    },
  };
}
