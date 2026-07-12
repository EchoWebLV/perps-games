import { Buffer } from "buffer";
import {
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
  SolanaMobileWalletAdapter,
} from "@solana-mobile/wallet-adapter-mobile";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { SolanaWalletPort } from "./solana-wallet";

const CLUSTER =
  (import.meta.env.VITE_SOLANA_CLUSTER as string | undefined) === "devnet"
    ? WalletAdapterNetwork.Devnet
    : WalletAdapterNetwork.Mainnet;

const RPC_URL =
  (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ??
  "https://api.mainnet-beta.solana.com";

export function createMobileWalletPort(): SolanaWalletPort {
  const adapter = new SolanaMobileWalletAdapter({
    addressSelector: createDefaultAddressSelector(),
    appIdentity: {
      name: "Perps Rider",
      uri: globalThis.location?.origin ?? "http://localhost",
      icon: "/icon-192.png",
    },
    authorizationResultCache: createDefaultAuthorizationResultCache(),
    cluster: CLUSTER,
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
  const connection = new Connection(RPC_URL, "confirmed");

  return {
    kind: "mobile-wallet-adapter",
    async connect() {
      // Android wallet intents must be started directly from a user gesture. Callers are responsible
      // for invoking this from a click or tap handler rather than during startup or background work.
      await adapter.connect();

      if (!adapter.publicKey) {
        throw new Error("wallet_connect_failed");
      }

      return {
        address: adapter.publicKey.toBase58(),
        label: adapter.name,
      };
    },
    async disconnect() {
      await adapter.disconnect();
    },
    currentAddress() {
      return adapter.publicKey?.toBase58() ?? null;
    },
    async signMessage(message) {
      return adapter.signMessage(message);
    },
    async signTransaction(txBase64) {
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      const signedTx = await adapter.signTransaction(tx);

      return Buffer.from(signedTx.serialize()).toString("base64");
    },
    async signAndSendTransaction(txBase64) {
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));

      return adapter.sendTransaction(tx, connection, { skipPreflight: false });
    },
  };
}
