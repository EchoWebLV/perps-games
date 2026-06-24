import { createSolanaRpc, type Base64EncodedWireTransaction } from "@solana/kit";

export interface PlayPaymentBroadcaster {
  broadcast(signedTxBase64: string): Promise<{ txSig: string }>;
}

export function makeRpcPlayPaymentBroadcaster(rpcUrl: string): PlayPaymentBroadcaster {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async broadcast(signedTxBase64) {
      const txSig = await rpc
        .sendTransaction(signedTxBase64 as Base64EncodedWireTransaction, {
          encoding: "base64",
          maxRetries: 3n,
          preflightCommitment: "confirmed",
        })
        .send();
      return { txSig: String(txSig) };
    },
  };
}
