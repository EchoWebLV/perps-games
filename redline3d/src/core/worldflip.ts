export const FLIP_SECS = 0.9; // how long the roll to upside down (and back) takes

export type WorldFlipPhase = "level" | "flipping" | "inverted" | "unwinding";

/**
 * Helmet "Barrel Roll" spectacle: when the player taps the flip button, the WHOLE
 * LEVEL rolls 180° to upside-down and RIDES inverted (up ↔ down swapped) until the
 * round settles, then unwinds back to level — the world literally turns over with the
 * flipped trade. Pure timer core (no three.js): main.ts adds the returned roll to the
 * camera after the chase cam's lookAt (0 while level, so every other car is untouched).
 * Once-per-round gating lives in the button (createBarrelRollCore); this rides the live
 * flag, so a round ending (or a park) always unwinds it.
 */
export function createWorldFlipCore() {
  let phase: WorldFlipPhase = "level";
  let t = 0; // 0 = level, 1 = fully inverted
  // cosine ease-in-out: slow bite, fast mid-roll, soft landing at upside-down
  const roll = () => (t <= 0 ? 0 : t >= 1 ? Math.PI : Math.PI * (0.5 - Math.cos(Math.PI * t) / 2));
  return {
    get phase() { return phase; },
    /** flip the world; true only if it actually engaged (level, once per round) */
    trigger(): boolean {
      if (phase !== "level") return false;
      phase = "flipping";
      return true;
    },
    /** advance the flip; returns the camera roll in radians (0 = level, π = upside down) */
    update(dt: number, live: boolean): number {
      if (!live && (phase === "flipping" || phase === "inverted")) phase = "unwinding";
      if (phase === "flipping") {
        t += dt / FLIP_SECS;
        if (t >= 1) { t = 1; phase = "inverted"; }
      } else if (phase === "unwinding") {
        t -= dt / FLIP_SECS;
        if (t <= 0) { t = 0; phase = "level"; } // level again — re-armed for the next round
      }
      return roll();
    },
  };
}
