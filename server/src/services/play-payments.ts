import type { DepositSource } from "../solana/deposit-source.js";
import type { DepositOutcome, Deposits } from "./deposits.js";
import { centsToBaseUnits } from "../money/usdc.js";

export const PLAY_PAYMENT_MIN_CENTS = 1;
export const PLAY_PAYMENT_MAX_CENTS = 5000;

export type PlayPaymentConfirmResult =
  | { status: "credited"; amountCents: number }
  | { status: "duplicate" }
  | { status: "pending" }
  | { status: "rejected"; reason: string };

export interface PlayPaymentConfirmer {
  confirm(txSig: string): Promise<PlayPaymentConfirmResult>;
  recover(input: { userId: string; sourceOwner: string; amountCents: number }): Promise<PlayPaymentConfirmResult>;
}

export function makePlayPaymentConfirmer(opts: {
  deposits: Deposits;
  source: Pick<DepositSource, "fetchInbound">;
  treasuryAta: string;
  lookupLimit?: number;
}): PlayPaymentConfirmer {
  const lookupLimit = opts.lookupLimit ?? 100;

  function mapOutcome(outcome: DepositOutcome): PlayPaymentConfirmResult {
    if (outcome.status === "credited") return { status: "credited", amountCents: outcome.amountCents };
    if (outcome.status === "duplicate") return { status: "duplicate" };
    return { status: "rejected", reason: outcome.reason };
  }

  return {
    async confirm(txSig) {
      const inbound = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, limit: lookupLimit });
      const transfer = inbound.find((t) => t.txSig === txSig);
      if (!transfer) return { status: "pending" };
      return mapOutcome(await opts.deposits.recordInbound(transfer));
    },
    async recover({ userId, sourceOwner, amountCents }) {
      const expectedBaseUnits = centsToBaseUnits(BigInt(amountCents));
      const inbound = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, limit: lookupLimit });
      let sawDuplicate = false;
      for (const transfer of inbound) {
        if (transfer.sourceOwner !== sourceOwner) continue;
        if (transfer.amountBaseUnits !== expectedBaseUnits) continue;
        const outcome = await opts.deposits.recordInbound(transfer);
        if (outcome.status === "duplicate") {
          sawDuplicate = true;
          continue;
        }
        if (outcome.status === "credited" && outcome.userId !== userId) {
          return { status: "rejected", reason: "source_bound_other" };
        }
        return mapOutcome(outcome);
      }
      return sawDuplicate ? { status: "duplicate" } : { status: "pending" };
    },
  };
}
