import { createSolanaRpc, signature } from "@solana/kit";
import type { ReadChainStatus, ChainStatus } from "../services/withdraw-worker.js";

/** Shape of one `getSignatureStatuses` value entry we care about. */
export interface SignatureStatusValue {
  confirmationStatus: string | null;
  err: unknown;
}

/**
 * Pure mapping from a `getSignatureStatuses` entry to the withdrawal confirmer's state.
 * A landed error is `failed` regardless of confirmation level (funds did not move).
 * Only an error-free `finalized` is `finalized`; everything else is `unknown` (poll again).
 */
export function mapSignatureStatus(value: SignatureStatusValue | null): ChainStatus {
  if (!value) return "unknown";
  if (value.err != null) return "failed";
  if (value.confirmationStatus === "finalized") return "finalized";
  return "unknown";
}

/** RPC-backed `ReadChainStatus` over `getSignatureStatuses` (searches recent + history). */
export function makeRpcChainStatusReader(rpcUrl: string): ReadChainStatus {
  const rpc = createSolanaRpc(rpcUrl);
  return async (txSig: string) => {
    const res = await rpc
      .getSignatureStatuses([signature(txSig)], { searchTransactionHistory: true })
      .send();
    const value = (res.value?.[0] ?? null) as SignatureStatusValue | null;
    return mapSignatureStatus(value);
  };
}
