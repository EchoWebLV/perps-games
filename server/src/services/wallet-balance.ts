import { address, createSolanaRpc } from "@solana/kit";
import { baseUnitsToCentsFloor } from "../money/usdc.js";
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
      const res = await rpc.getTokenAccountsByOwner(
        address(walletPublicKey),
        { mint },
        { commitment: "finalized", encoding: "jsonParsed" } as any,
      ).send();
      const accounts = (res as any).value ?? [];
      let total = 0n;
      for (const account of accounts) {
        const amount = account?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amount === "string") total += BigInt(amount);
      }
      // Display read: a wallet may hold sub-cent dust (e.g. 9.4508 USDC) — floor it.
      // Throwing here (strict baseUnitsToCents) surfaced as a 503 and blocked deposits.
      return Number(baseUnitsToCentsFloor(total));
    },
  };
}
