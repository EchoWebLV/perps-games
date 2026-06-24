import type { PrivyClient } from "@privy-io/node";
import {
  address,
  createSolanaRpc,
  type Base64EncodedWireTransaction,
  type BlockhashLifetimeConstraint,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { centsToBaseUnits, USDC_DECIMALS } from "../money/usdc.js";
import { buildUnsignedTransferCheckedWireTx } from "./transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "./constants.js";

export interface SignResult { txSig: string; privyTxId: string | null; }
/** Signs+sends a USDC transfer from the treasury to a destination. */
export interface WithdrawSigner {
  signAndSend(input: { destWallet: string; amountCents: number; idempotencyKey: string }): Promise<SignResult>;
}

export function makePrivyWithdrawSigner(deps: {
  privy: PrivyClient; treasuryWalletId: string; treasuryUsdcAta: string; treasuryOwner: string;
  usdcMint: string; rpcUrl: string; getLatestBlockhash?: () => Promise<BlockhashLifetimeConstraint>;
  sendSignedTransaction?: (signedTxBase64: string) => Promise<string>;
}): WithdrawSigner {
  const rpc = createSolanaRpc(deps.rpcUrl);
  const mint = address(deps.usdcMint);
  const source = address(deps.treasuryUsdcAta);
  const treasuryOwner = address(deps.treasuryOwner);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);
  const sendSignedTransaction = deps.sendSignedTransaction ?? (async (signedTxBase64) => {
    const txSig = await rpc
      .sendTransaction(signedTxBase64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        maxRetries: 3n,
        preflightCommitment: "confirmed",
      })
      .send();
    return String(txSig);
  });
  const getLatestBlockhash = deps.getLatestBlockhash ?? (() => {
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
      const res = await (deps.privy.wallets().solana() as any).signTransaction(deps.treasuryWalletId, {
        transaction: txBase64,
        idempotency_key: idempotencyKey,
      });
      const signedTx = res?.signed_transaction ?? res?.data?.signed_transaction;
      if (!signedTx) throw new Error("privy_sign_transaction_missing_signed_transaction");
      const txSig = await sendSignedTransaction(signedTx);
      return { txSig, privyTxId: null };
    },
  };
}
