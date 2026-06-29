import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletPort } from "../core/solana-wallet";

/** The subset of anchor's Wallet that AnchorProvider requires. */
export interface AnchorWalletLike {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/**
 * Adapt any SolanaWalletPort into an anchor-compatible Wallet. The port signs base64;
 * we serialize (legacy Transaction) → port.signTransaction → deserialize. Slice 1 only
 * builds legacy transactions (anchor `.transaction()`), so the legacy branch is the
 * exercised path; versioned txs throw (not used this slice).
 */
export function portToAnchorWallet(port: SolanaWalletPort): AnchorWalletLike {
  const addr = port.currentAddress();
  if (!addr) throw new Error("wallet_port_not_connected");
  const publicKey = new PublicKey(addr);

  async function sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) throw new Error("versioned_tx_unsupported_slice1");
    const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const signedB64 = await port.signTransaction(b64);
    return Transaction.from(Buffer.from(signedB64, "base64")) as T;
  }

  return {
    publicKey,
    signTransaction: sign,
    async signAllTransactions(txs) { const out = []; for (const t of txs) out.push(await sign(t)); return out; },
  };
}
