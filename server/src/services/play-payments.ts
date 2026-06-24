import type { DepositSource } from "../solana/deposit-source.js";
import type { DepositOutcome, Deposits } from "./deposits.js";

export type PlayPaymentConfirmResult =
  | { status: "credited"; amountCents: number }
  | { status: "duplicate" }
  | { status: "pending" }
  | { status: "rejected"; reason: string };

export interface PlayPaymentConfirmer {
  confirm(txSig: string): Promise<PlayPaymentConfirmResult>;
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
  };
}
