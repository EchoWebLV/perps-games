import { and, eq } from "drizzle-orm";
import { withdrawals } from "../db/schema.js";
import { withdrawIdempotencyKey } from "../money/idempotency.js";

export interface WithdrawSigner {
  signAndSend(input: {
    destWallet: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ txSig: string; providerTxId: string | null }>;
}

export function makeWithdrawProcessor(db: any, signer: WithdrawSigner) {
  return {
    /** Admin-gated: awaiting_approval -> signing -> send -> sent. Idempotency key makes the send exactly-once. */
    async approveAndSend(id: string): Promise<{ status: "sent" | "not_approvable" }> {
      const claimed = await db.update(withdrawals)
        .set({ status: "signing", updatedAt: new Date() })
        .where(and(eq(withdrawals.id, id), eq(withdrawals.status, "awaiting_approval")))
        .returning();
      if (claimed.length === 0) return { status: "not_approvable" };
      const w = claimed[0];
      const res = await signer.signAndSend({
        destWallet: w.destWallet, amountCents: w.amountCents, idempotencyKey: withdrawIdempotencyKey(w.id),
      });
      await db.update(withdrawals)
        .set({ status: "sent", txSig: res.txSig, providerTxId: res.providerTxId, updatedAt: new Date() })
        .where(eq(withdrawals.id, id));
      return { status: "sent" };
    },
  };
}

export type WithdrawProcessor = ReturnType<typeof makeWithdrawProcessor>;

import type { Ledger } from "./ledger.js";

/** On-chain status of a sent withdrawal signature. */
export type ChainStatus = "finalized" | "failed" | "unknown";
export type ReadChainStatus = (txSig: string) => Promise<ChainStatus>;

/**
 * How long a `sent` tx may sit not-yet-finalized before we stop waiting and flag it for manual
 * review. Solana blockhash validity is ~60-90s, so past this an unfinalized tx was almost certainly
 * dropped and will never land — but we still never auto-reverse (it MIGHT have landed), only escalate.
 */
const DEFAULT_CONFIRM_STALE_SECONDS = 180;

export function makeWithdrawConfirmer(
  db: any,
  ledger: Ledger,
  readStatus: ReadChainStatus,
  opts?: { staleSeconds?: number },
) {
  const staleSeconds = opts?.staleSeconds ?? DEFAULT_CONFIRM_STALE_SECONDS;
  return {
    /**
     * From `sent`: -> confirmed (finalized) | -> reversed (landed-but-failed) | -> pending (not yet
     * finalized; leave in `sent` and retry next poll) | -> needs_review (still unknown past the stale
     * window). `unknown` is the NORMAL transient state for a freshly-broadcast tx — escalating it
     * immediately would mark every withdrawal for review before it could finalize.
     */
    async confirm(id: string): Promise<"confirmed" | "reversed" | "pending" | "needs_review" | "skip"> {
      const rows = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
      const w = rows[0];
      if (!w || w.status !== "sent" || !w.txSig) return "skip";
      const status = await readStatus(w.txSig);
      if (status === "finalized") {
        await db.update(withdrawals).set({ status: "confirmed", updatedAt: new Date() }).where(eq(withdrawals.id, id));
        return "confirmed";
      }
      if (status === "failed") {
        await db.transaction(async (tx: any) => {
          await ledger.creditOn(tx, w.userId, "cash", w.amountCents, "withdraw_reverse", w.id);
          await tx.update(withdrawals).set({ status: "reversed", updatedAt: new Date() }).where(eq(withdrawals.id, id));
        });
        return "reversed";
      }
      // unknown: still pending finalization. Wait (leave in `sent`) until it's been too long to
      // plausibly still land, then escalate to manual review. `updatedAt` is the sent time (set by
      // approveAndSend and untouched while `sent`), so its age is how long the tx has been pending.
      const sentMs = new Date(w.updatedAt).getTime();
      if (Number.isFinite(sentMs) && Date.now() - sentMs < staleSeconds * 1000) return "pending";
      await db.update(withdrawals).set({ status: "needs_review", reviewReason: "status_unknown", updatedAt: new Date() }).where(eq(withdrawals.id, id));
      return "needs_review";
    },
  };
}
