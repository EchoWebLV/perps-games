import type { Phase } from "./types";

// Mode switches (race ⇄ lobby ⇄ highway) must stay frozen while money is in motion.
// The subtle window is `opening`: between the GO press and open() resolving (multi-
// second on devnet) the engine is still "idle" and no round is active locally — but a
// live on-chain round is about to exist. A mode switch inside that window strands the
// player in the lobby while the round runs invisibly (money is safe — the crank
// settles — but the race HUD is gone). One predicate for every mode switch so a new
// mode can't forget a flag.
export function modeSwitchBlocked(s: { opening: boolean; phase: Phase; roundActive?: boolean }): boolean {
  return s.opening || s.phase === "live" || !!s.roundActive;
}
