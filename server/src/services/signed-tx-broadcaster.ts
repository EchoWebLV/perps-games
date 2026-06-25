import {
  assertIsFullySignedTransaction,
  createSolanaRpc,
  type Base64EncodedWireTransaction,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from "@solana/kit";

export interface SignedTxBroadcaster {
  broadcastSignedDeposit(input: { expectedTxBase64: string; signedTxBase64: string }): Promise<{ txSig: string }>;
}

export function makeSignedTxBroadcaster(sendTransaction: (txBase64: string) => Promise<string>): SignedTxBroadcaster {
  return {
    async broadcastSignedDeposit({ expectedTxBase64, signedTxBase64 }) {
      const expected = getTransactionDecoder().decode(Buffer.from(expectedTxBase64, "base64"));
      const signed = getTransactionDecoder().decode(Buffer.from(signedTxBase64, "base64"));
      if (Buffer.compare(Buffer.from(expected.messageBytes), Buffer.from(signed.messageBytes)) !== 0) {
        throw new Error("signed_transaction_message_mismatch");
      }
      for (const address of Object.keys(expected.signatures) as Array<keyof typeof expected.signatures>) {
        if (expected.signatures[address] && !signed.signatures[address]) {
          throw new Error("signed_transaction_missing_existing_signature");
        }
      }
      assertIsFullySignedTransaction(signed);
      const txSig = await sendTransaction(getBase64EncodedWireTransaction(signed));
      return { txSig };
    },
  };
}

export function makeRpcSignedTxBroadcaster(rpcUrl: string): SignedTxBroadcaster {
  const rpc = createSolanaRpc(rpcUrl);
  return makeSignedTxBroadcaster((txBase64) =>
    rpc.sendTransaction(txBase64 as Base64EncodedWireTransaction, { encoding: "base64" }).send(),
  );
}
