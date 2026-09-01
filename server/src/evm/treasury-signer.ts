import { erc20Abi } from "viem";
import { centsToBaseUnits } from "../money/usdc.js";
import type { WithdrawSigner } from "../services/withdraw-worker.js";
import type { TreasuryWalletClient } from "./client.js";

/**
 * EVM treasury withdraw signer: one ERC-20 `transfer(dest, amount)` from the treasury account.
 *
 * Exactly-once is the caller's DB state machine, not this signer — `approveAndSend` claims the row
 * (awaiting_approval → signing) with a conditional UPDATE, so a row that has been sent is never
 * re-sent. Same contract as the Solana signer; `idempotencyKey` satisfies the port and is unused
 * here (an EVM transfer carries no memo/idempotency field).
 *
 * Amount conversion is BigInt-only via {@link centsToBaseUnits} — the ledger's integer cents map
 * exactly onto 6-decimal base units, and no float ever touches the amount. A non-integer cents value
 * throws out of `BigInt()` rather than rounding: on this path a wrong amount must fail loudly.
 *
 * Takes the account-and-chain-bound {@link TreasuryWalletClient} (not a bare `WalletClient`, which
 * erases both), so the signing account and chain come from the client instead of being restated on
 * every write and risking drift from the configured treasury.
 *
 * Nonces: viem's wallet client fills them from the node; the withdraw worker sends serially.
 */
export function makeEvmTreasurySigner(wallet: TreasuryWalletClient, cfg: { usdc: string }): WithdrawSigner {
  const usdc = cfg.usdc.toLowerCase() as `0x${string}`;
  return {
    async signAndSend({ destWallet, amountCents }) {
      const txSig = await wallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [destWallet as `0x${string}`, centsToBaseUnits(BigInt(amountCents))],
      });
      // No third-party provider on this rail: the tx hash is the whole receipt.
      return { txSig, providerTxId: null };
    },
  };
}
