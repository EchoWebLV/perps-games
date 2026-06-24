import { address, createSolanaRpc } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { baseUnitsToCents } from "../money/usdc.js";
import { LEGACY_TOKEN_PROGRAM } from "../solana/constants.js";

export interface WalletBalanceReader {
  /** User wallet USDC balance, in cents. Missing token accounts read as 0. */
  balanceCents(walletPublicKey: string): Promise<number>;
}

export function makeRpcWalletBalanceReader(rpcUrl: string, usdcMint: string): WalletBalanceReader {
  const rpc = createSolanaRpc(rpcUrl);
  const mint = address(usdcMint);
  const tokenProgram = address(LEGACY_TOKEN_PROGRAM);

  return {
    async balanceCents(walletPublicKey) {
      const [ata] = await findAssociatedTokenPda({ owner: address(walletPublicKey), mint, tokenProgram });
      try {
        const res = await rpc.getTokenAccountBalance(ata, { commitment: "finalized" } as any).send();
        return Number(baseUnitsToCents(BigInt((res as any).value.amount)));
      } catch {
        return 0;
      }
    },
  };
}
