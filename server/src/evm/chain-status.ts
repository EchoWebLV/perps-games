import type { PublicClient } from "viem";
import type { ChainStatus, ReadChainStatus } from "../services/withdraw-worker.js";

type ReceiptLite = { status: "success" | "reverted"; blockNumber: bigint } | null;

/**
 * Pure mapping mirroring solana/chain-status.ts: a landed-but-reverted tx is `failed` regardless of
 * depth (the funds did not move), a success is `finalized` only once it is buried at least
 * `confirmations` blocks deep, and anything else is `unknown` (poll again).
 */
export function mapReceiptStatus(receipt: ReceiptLite, head: bigint, confirmations: number): ChainStatus {
  if (!receipt) return "unknown";
  if (receipt.status === "reverted") return "failed";
  return head - receipt.blockNumber >= BigInt(confirmations) ? "finalized" : "unknown";
}

/**
 * Receipt-backed `ReadChainStatus`. viem signals a not-yet-mined tx by THROWING
 * (`TransactionReceiptNotFoundError`) rather than returning null, so a receipt-read failure maps to
 * `unknown` — the normal transient state for a freshly broadcast tx, which the withdraw confirmer
 * leaves in `sent` and retries. Other RPC failures (the head read) propagate, as on the Solana rail.
 */
export function makeEvmChainStatusReader(client: PublicClient, confirmations: number): ReadChainStatus {
  return async (txSig: string) => {
    let receipt: ReceiptLite = null;
    try {
      receipt = (await client.getTransactionReceipt({ hash: txSig as `0x${string}` })) as unknown as ReceiptLite;
    } catch {
      return "unknown";
    }
    // Only read the head once there IS a receipt to measure depth against — a missing receipt is
    // already `unknown`, so fetching the block number for it would be a wasted RPC round trip.
    if (!receipt) return "unknown";
    return mapReceiptStatus(receipt, await client.getBlockNumber(), confirmations);
  };
}
