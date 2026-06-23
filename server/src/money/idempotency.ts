/**
 * Deterministic Privy idempotency key for an outbound withdrawal (real-money rails, spec §6.2).
 *
 * Privy dedups a `signAndSendTransaction` only when the **caller** supplies a stable
 * idempotency key (the SDK's auto-generated default would NOT dedup a retry from a fresh
 * process after a crash). The key is `'withdraw:'||withdrawalId`, persisted on the
 * `withdrawals` row in the SAME tx as the reserve-debit — BEFORE any network call — so a
 * crash/timeout after broadcast can never produce a second transfer. Two distinct
 * withdrawals must never share a key, and the key must match the persisted id byte-for-byte.
 */

export const WITHDRAW_IDEMPOTENCY_PREFIX = "withdraw:";

/** Build the deterministic key for a withdrawal. Throws on an empty/whitespace id. */
export function withdrawIdempotencyKey(withdrawalId: string): string {
  if (typeof withdrawalId !== "string" || withdrawalId.trim() === "") {
    throw new Error("withdrawIdempotencyKey: withdrawalId must be a non-empty id");
  }
  // Embed the id verbatim (no trimming): the key must be byte-identical to the stored id.
  return `${WITHDRAW_IDEMPOTENCY_PREFIX}${withdrawalId}`;
}
