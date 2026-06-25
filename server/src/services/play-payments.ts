import type { DepositSource } from "../solana/deposit-source.js";
import type { DepositOutcome, Deposits } from "./deposits.js";
import { baseUnitsToCents, centsToBaseUnits } from "../money/usdc.js";

export const PLAY_PAYMENT_MIN_CENTS = 1;
export const PLAY_PAYMENT_MAX_CENTS = 5000;

export type PlayPaymentConfirmResult =
  | { status: "credited"; amountCents: number; paymentCents: number; txSigs: string[] }
  | { status: "duplicate" }
  | { status: "pending" }
  | { status: "rejected"; reason: string };

export interface PlayPaymentConfirmer {
  confirm(input: { txSig: string; userId: string; sourceOwner: string }): Promise<PlayPaymentConfirmResult>;
  recover(input: { userId: string; sourceOwner: string; amountCents: number }): Promise<PlayPaymentConfirmResult>;
}

export function makePlayPaymentConfirmer(opts: {
  deposits: Deposits;
  source: Pick<DepositSource, "fetchInbound"> & Partial<Pick<DepositSource, "fetchTransfer">>;
  treasuryAta: string;
  lookupLimit?: number;
}): PlayPaymentConfirmer {
  const lookupLimit = opts.lookupLimit ?? 100;

  function mapOutcome(outcome: DepositOutcome, txSig: string): PlayPaymentConfirmResult {
    if (outcome.status === "credited") {
      return { status: "credited", amountCents: outcome.amountCents, paymentCents: outcome.amountCents, txSigs: [txSig] };
    }
    if (outcome.status === "duplicate") return { status: "duplicate" };
    return { status: "rejected", reason: outcome.reason };
  }

  function centsFromBaseUnits(baseUnits: bigint): number | null {
    try {
      return Number(baseUnitsToCents(baseUnits));
    } catch {
      return null;
    }
  }

  async function recordMatchingTransfers(input: {
    inbound: Awaited<ReturnType<DepositSource["fetchInbound"]>>;
    userId: string;
    sourceOwner: string;
    expectedBaseUnits: bigint;
    paymentCents: number;
  }): Promise<PlayPaymentConfirmResult> {
    let sawDuplicate = false;
    let amountCents = 0;
    const txSigs: string[] = [];

    for (const transfer of input.inbound) {
      if (transfer.sourceOwner !== input.sourceOwner) continue;
      if (transfer.amountBaseUnits !== input.expectedBaseUnits) continue;
      const outcome = await opts.deposits.recordInbound(transfer);
      if (outcome.status === "duplicate") {
        sawDuplicate = true;
        continue;
      }
      if (outcome.status === "credited") {
        if (outcome.userId !== input.userId) return { status: "rejected", reason: "source_bound_other" };
        amountCents += outcome.amountCents;
        txSigs.push(transfer.txSig);
        continue;
      }
      return mapOutcome(outcome, transfer.txSig);
    }

    if (amountCents > 0) return { status: "credited", amountCents, paymentCents: input.paymentCents, txSigs };
    return sawDuplicate ? { status: "duplicate" } : { status: "pending" };
  }

  return {
    async confirm({ txSig, userId, sourceOwner }) {
      const directTransfer = opts.source.fetchTransfer
        ? await opts.source.fetchTransfer({ treasuryAta: opts.treasuryAta, txSig })
        : null;
      if (directTransfer) {
        if (directTransfer.sourceOwner !== sourceOwner) return { status: "rejected", reason: "source_mismatch" };
        const paymentCents = centsFromBaseUnits(directTransfer.amountBaseUnits);
        if (paymentCents == null) return mapOutcome(await opts.deposits.recordInbound(directTransfer), directTransfer.txSig);
        return recordMatchingTransfers({
          inbound: [directTransfer],
          userId,
          sourceOwner,
          expectedBaseUnits: directTransfer.amountBaseUnits,
          paymentCents,
        });
      }

      const inbound = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, limit: lookupLimit });
      const transfer = inbound.find((t) => t.txSig === txSig);
      if (!transfer) return { status: "pending" };
      if (transfer.sourceOwner !== sourceOwner) return { status: "rejected", reason: "source_mismatch" };
      const paymentCents = centsFromBaseUnits(transfer.amountBaseUnits);
      if (paymentCents == null) return mapOutcome(await opts.deposits.recordInbound(transfer), transfer.txSig);
      return recordMatchingTransfers({
        inbound,
        userId,
        sourceOwner,
        expectedBaseUnits: transfer.amountBaseUnits,
        paymentCents,
      });
    },
    async recover({ userId, sourceOwner, amountCents }) {
      const expectedBaseUnits = centsToBaseUnits(BigInt(amountCents));
      const inbound = await opts.source.fetchInbound({ treasuryAta: opts.treasuryAta, limit: lookupLimit });
      return recordMatchingTransfers({ inbound, userId, sourceOwner, expectedBaseUnits, paymentCents: amountCents });
    },
  };
}
