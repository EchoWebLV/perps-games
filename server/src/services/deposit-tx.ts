/**
 * Build an UNSIGNED USDC `transferChecked` (user wallet → treasury ATA) for the
 * "deposit to game" flow (real-money rails, spec §5/§6).
 *
 * The server authors the full transaction message from server-trusted config (mint, treasury
 * destination) plus the user's bound wallet, and reserves the user's signature slot (authority +
 * fee payer). The client signs the exact returned bytes — the server controls 100% of the message.
 * For a deposit BOTH the source-ATA authority and the fee payer are the user's own wallet, so the
 * compiled tx has a single signer slot (the user).
 *
 * The recent-blockhash lifetime is injected (`getLatestBlockhash`) so production fetches it from
 * the Solana RPC while tests pin a fixed blockhash for determinism.
 */
import { address, createSolanaRpc, type BlockhashLifetimeConstraint } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { buildUnsignedTransferCheckedWireTx } from "../solana/transfer-tx.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";
import { centsToBaseUnits, USDC_DECIMALS } from "../money/usdc.js";

export interface DepositTxBuilder {
  buildForUser(userWallet: string, amountCents: number): Promise<{ txBase64: string }>;
}

export interface DepositTxDeps {
  usdcMint: string;
  treasuryUsdcAta: string;
  /** server-fetched recent blockhash lifetime (injectable for tests) */
  getLatestBlockhash: () => Promise<BlockhashLifetimeConstraint>;
}

export function makeDepositTxBuilder(deps: DepositTxDeps): DepositTxBuilder {
  const mint = address(deps.usdcMint);
  const destination = address(deps.treasuryUsdcAta);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);
  return {
    async buildForUser(userWallet, amountCents) {
      const owner = address(userWallet);
      const [sourceAta] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      const lifetime = await deps.getLatestBlockhash();
      const txBase64 = buildUnsignedTransferCheckedWireTx({
        source: sourceAta,
        mint,
        destination,
        authority: owner, // user owns the source ATA (signer slot)
        feePayer: owner, // user pays the SOL network fee — single signer
        amount: centsToBaseUnits(BigInt(amountCents)),
        decimals: USDC_DECIMALS,
        lifetime,
      });
      return { txBase64 };
    },
  };
}

/** Production recent-blockhash fetch from the Solana RPC. */
export function makeRpcBlockhash(rpcUrl: string): () => Promise<BlockhashLifetimeConstraint> {
  const rpc = createSolanaRpc(rpcUrl);
  return async () => {
    const { value } = await rpc.getLatestBlockhash().send();
    return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
  };
}
