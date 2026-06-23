import type { PrivyClient } from "@privy-io/node";

export interface SignResult { txSig: string; privyTxId: string | null; }
/** Signs+sends a USDC transfer from the treasury to a destination, exactly-once via the idempotency key. */
export interface WithdrawSigner {
  signAndSend(input: { destWallet: string; amountCents: number; idempotencyKey: string }): Promise<SignResult>;
}

/**
 * Real Privy-backed signer. STAGING-GATED: the Privy signAndSendTransaction behavior is validated by the
 * Phase-0 staging checklist (items 1-6) before this runs against real funds. The body is a guarded stub —
 * it CANNOT be correctly finalized until staging confirms the fee-payer / byte / hash semantics. The state
 * machine (withdraw-worker.ts) is fully tested against a FAKE signer, so this stub blocks nothing.
 */
export function makePrivyWithdrawSigner(deps: {
  privy: PrivyClient; treasuryWalletId: string; treasuryUsdcAta: string; treasuryOwner: string;
  usdcMint: string; caip2: string; rpcUrl: string;
}): WithdrawSigner {
  return {
    async signAndSend({ destWallet, amountCents, idempotencyKey }) {
      // Filled when Phase 0 staging confirms signAndSendTransaction semantics:
      // 1. derive destination USDC ATA for destWallet; 2. buildUnsignedTransferCheckedWireTx(treasury→dest);
      // 3. privy.wallets().solana().signAndSendTransaction(treasuryWalletId, { transaction, caip2, idempotency_key });
      // 4. return { txSig: res.hash, privyTxId: res.transaction_id ?? null }.
      void destWallet; void amountCents; void idempotencyKey; void deps;
      throw new Error("makePrivyWithdrawSigner.signAndSend not yet enabled — pending Phase 0 staging validation");
    },
  };
}
