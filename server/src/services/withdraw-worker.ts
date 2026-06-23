import { and, eq } from "drizzle-orm";
import { withdrawals } from "../db/schema.js";
import { withdrawIdempotencyKey } from "../money/idempotency.js";
import type { WithdrawSigner } from "../solana/withdraw-signer.js";

export function makeWithdrawProcessor(db: any, signer: WithdrawSigner) {
  return {
    /** Admin-gated: awaiting_approval → signing → (Privy send) → sent. Idempotency key makes the send exactly-once. */
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
        .set({ status: "sent", txSig: res.txSig, privyTxId: res.privyTxId, updatedAt: new Date() })
        .where(eq(withdrawals.id, id));
      return { status: "sent" };
    },
  };
}

export type WithdrawProcessor = ReturnType<typeof makeWithdrawProcessor>;
