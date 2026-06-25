import {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

export interface FeePayerSigner {
  signFeePayerTx(txBase64: string): Promise<string>;
}

export function parseFeePayerSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Uint8Array.from(parsed);
  }
  return Uint8Array.from(Buffer.from(trimmed, "base64"));
}

export function makeFeePayerSignerFromKeyPair(keyPair: CryptoKeyPair): FeePayerSigner {
  return {
    async signFeePayerTx(txBase64) {
      const tx = getTransactionDecoder().decode(Buffer.from(txBase64, "base64"));
      const signed = await partiallySignTransaction([keyPair], tx);
      return getBase64EncodedWireTransaction(signed);
    },
  };
}

export async function makeFeePayerSigner(secret: string): Promise<FeePayerSigner & { address: string }> {
  const signer = await createKeyPairSignerFromBytes(parseFeePayerSecret(secret), false);
  return {
    address: signer.address,
    ...makeFeePayerSignerFromKeyPair(signer.keyPair),
  };
}
