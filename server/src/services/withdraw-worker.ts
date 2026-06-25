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
        .set({ status: "sent", txSig: res.txSig, privyTxId: res.providerTxId, updatedAt: new Date() })
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

export function makeWithdrawConfirmer(db: any, ledger: Ledger, readStatus: ReadChainStatus) {
  return {
    /** From `sent`, the only auto-transitions: -> confirmed (finalized) | -> reversed (landed-but-failed) | -> needs_review (unknown). */
    async confirm(id: string): Promise<"confirmed" | "reversed" | "needs_review" | "skip"> {
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
      await db.update(withdrawals).set({ status: "needs_review", reviewReason: "status_unknown", updatedAt: new Date() }).where(eq(withdrawals.id, id));
      return "needs_review";
    },
  };
}
