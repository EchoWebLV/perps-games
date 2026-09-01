import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { crateCommits } from "../db/schema.js";

/**
 * Server-proven crate randomness (commit-reveal). Replaces the parked Solana VRF on the EVM rail:
 * the server can't grind the outcome because it publishes `sha256(seed‖nonce)` BEFORE the player
 * commits to an open, and the client re-derives both the commitment and the draws from the revealed
 * seed. A commit is single-shot, so a revealed seed can never be replayed for a second roll.
 *
 * PUBLISHED DERIVATION (the client mirrors this byte-for-byte):
 *   draw[i] = sha256(seed ‖ [i]).readUInt32BE(0) / 2^32
 */
export function drawsFromSeed(seed: Uint8Array, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    createHash("sha256").update(seed).update(Buffer.from([i])).digest().readUInt32BE(0) / 2 ** 32);
}

export interface CrateCommitment {
  commitId: string;
  /** hex sha256(seed‖nonce) — the ONLY half published before the open. */
  commitment: string;
}

export interface CrateReveal {
  draws: number[];
  seedHex: string;
  nonceHex: string;
  commitment: string;
}

/** A draw index is one byte, so a single commit can back at most 256 draws. */
const MAX_DRAWS = 256;

export function makeCrateRoll(db: any) {
  return {
    /** Reserve a fresh seed for this user and publish only its commitment. */
    async commit(userId: string): Promise<CrateCommitment> {
      const seed = randomBytes(32);
      const nonce = randomBytes(16);
      const commitmentHex = createHash("sha256").update(seed).update(nonce).digest("hex");
      const [row] = await db.insert(crateCommits).values({
        userId,
        seedHex: seed.toString("hex"),
        nonceHex: nonce.toString("hex"),
        commitmentHex,
      }).returning();
      return { commitId: row.id, commitment: row.commitmentHex };
    },

    /**
     * Spend a commit and reveal it. The conditional `used_at IS NULL -> now()` update is the claim
     * (same single-shot pattern as the withdraw processor's `awaiting_approval -> signing`), so two
     * concurrent opens can never both roll from the same seed.
     */
    async consume(userId: string, commitId: string, n: number): Promise<CrateReveal> {
      if (!Number.isInteger(n) || n < 1 || n > MAX_DRAWS) throw new Error("bad_draw_count");
      if (!/^[0-9a-fA-F-]{36}$/.test(commitId)) throw new Error("commit_not_found");
      const claimed = await db.update(crateCommits)
        .set({ usedAt: new Date() })
        .where(and(
          eq(crateCommits.id, commitId),
          eq(crateCommits.userId, userId),
          isNull(crateCommits.usedAt),
        ))
        .returning();
      if (claimed.length === 0) {
        // Distinguish "already spent" from "never yours": both are refusals, but a used commit is a
        // retry the client can recover from (ask for a new commit) while not-found is a bad request.
        const existing = await db.select().from(crateCommits)
          .where(and(eq(crateCommits.id, commitId), eq(crateCommits.userId, userId)));
        throw new Error(existing.length > 0 ? "commit_used" : "commit_not_found");
      }
      const row = claimed[0];
      return {
        draws: drawsFromSeed(Buffer.from(row.seedHex, "hex"), n),
        seedHex: row.seedHex,
        nonceHex: row.nonceHex,
        commitment: row.commitmentHex,
      };
    },
  };
}

export type CrateRoll = ReturnType<typeof makeCrateRoll>;
