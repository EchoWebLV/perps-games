import { Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { SolanaWalletPort } from "../core/solana-wallet";

const STORE_KEY = "redline.chain.devkey.v1";

interface Store {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

const browserStore: Store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/**
 * A SolanaWalletPort backed by a local Keypair — devnet/dev only. Auto-signs (no
 * popup) so the on-chain loop is testable headlessly and in Claude Preview without a
 * browser extension. The keypair is persisted (base64 secretKey) so the same address
 * survives reloads (and can be funded once by the operator). `.keypair` is exposed so
 * the anchor-wallet adapter can sign without a base64 round-trip if it wants.
 */
export function createDevKeypairPort(opts?: { secretKey?: Uint8Array; store?: Store }): SolanaWalletPort & { keypair: Keypair } {
  const store = opts?.store ?? browserStore;
  let kp: Keypair;
  if (opts?.secretKey) {
    kp = Keypair.fromSecretKey(opts.secretKey);
  } else {
    const saved = store.get(STORE_KEY);
    if (saved) {
      kp = Keypair.fromSecretKey(Buffer.from(saved, "base64"));
    } else {
      kp = Keypair.generate();
      store.set(STORE_KEY, Buffer.from(kp.secretKey).toString("base64"));
    }
  }
  const address = kp.publicKey.toBase58();
  return {
    kind: "web-standard",
    keypair: kp,
    async connect() { return { address, label: "dev-keypair" }; },
    async disconnect() { /* no-op */ },
    currentAddress() { return address; },
    async signMessage(message: Uint8Array) { return nacl.sign.detached(message, kp.secretKey); },
    async signTransaction(txBase64: string) {
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      tx.partialSign(kp);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    },
  };
}
