import type { PrivyClient } from "@privy-io/node";
import { address, createSolanaRpc, type BlockhashLifetimeConstraint } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { centsToBaseUnits, USDC_DECIMALS } from "../money/usdc.js";
import { buildUnsignedTransferCheckedWireTx } from "./transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

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
  usdcMint: string; caip2: string; rpcUrl: string; getLatestBlockhash?: () => Promise<BlockhashLifetimeConstraint>;
}): WithdrawSigner {
  const mint = address(deps.usdcMint);
  const source = address(deps.treasuryUsdcAta);
  const treasuryOwner = address(deps.treasuryOwner);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);
  const getLatestBlockhash = deps.getLatestBlockhash ?? (() => {
    const rpc = createSolanaRpc(deps.rpcUrl);
    return async () => {
      const { value } = await rpc.getLatestBlockhash().send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    };
  })();

  return {
    async signAndSend({ destWallet, amountCents, idempotencyKey }) {
      const owner = address(destWallet);
      const [destination] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      const txBase64 = buildUnsignedTransferCheckedWireTx({
        source,
        mint,
        destination,
        authority: treasuryOwner,
        feePayer: treasuryOwner,
        amount: centsToBaseUnits(BigInt(amountCents)),
        decimals: USDC_DECIMALS,
        lifetime: await getLatestBlockhash(),
      });
      const res = await (deps.privy.wallets().solana() as any).signAndSendTransaction(deps.treasuryWalletId, {
        transaction: txBase64,
        caip2: deps.caip2,
        idempotency_key: idempotencyKey,
      });
      const txSig = res?.hash ?? res?.data?.hash;
      if (!txSig) throw new Error("privy_sign_and_send_missing_hash");
      return { txSig, privyTxId: res?.transaction_id ?? res?.data?.transaction_id ?? null };
    },
  };
}
