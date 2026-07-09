/** The confirmed on-chain round as the client reads it (session.poll / a flip's re-anchored result). */
export interface ConfirmedRound { status: number; dir: number; entryHuman: number; }

/**
 * Reconcile an OPTIMISTIC local flip against the confirmed on-chain round. The Clown-Car lane-bet and
 * the Helmet barrel-roll flip the local HUD+engine instantly for feel, then mirror the flip on-chain
 * in the background. If that background flip FAILS (rejects) or its verified re-read DISAGREES, the
 * chain is authoritative: the local position must snap back to what the chain actually holds — otherwise
 * the HUD (and the liq line) show a direction the chain never took, while close() would settle the other.
 *
 * Returns the {dir, entryPx} the local state must revert to, or null when there's nothing to do:
 * the optimistic direction already matches the chain, or there's no live round to reconcile against
 * (in which case close()/the crank settle at on-chain truth anyway).
 */
export function reconcileFlip(
  optimisticDir: 1 | -1,
  chain: ConfirmedRound | null | undefined,
): { dir: 1 | -1; entryPx: number } | null {
  if (!chain || chain.status !== 1) return null;         // no live round → settle path owns the truth
  if (chain.dir !== 1 && chain.dir !== -1) return null;   // unreadable direction — never snap to garbage
  if (chain.dir === optimisticDir) return null;           // chain agrees → the optimistic flip held
  return { dir: chain.dir, entryPx: chain.entryHuman };   // chain disagrees → snap back to it
}
