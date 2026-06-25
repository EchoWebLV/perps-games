import { Buffer } from "buffer";
import { StandardWalletAdapter } from "@solana/wallet-standard-wallet-adapter-base";
import type { WalletAdapterCompatibleStandardWallet } from "@solana/wallet-adapter-base";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { SolanaWalletPort } from "./solana-wallet";

const RPC_URL =
  (import.meta.env?.VITE_SOLANA_RPC_URL as string | undefined) ??
  "https://api.mainnet-beta.solana.com";

function supportsSolanaChain(wallet: WalletAdapterCompatibleStandardWallet): boolean {
  return wallet.chains.some((chain) => chain === "solana:mainnet" || chain === "solana:devnet");
}

function pickWallet(): WalletAdapterCompatibleStandardWallet {
  const wallets = getWallets().get() as readonly WalletAdapterCompatibleStandardWallet[];
  const candidates = wallets.filter(supportsSolanaChain);
  const preferred =
    candidates.find((wallet) => /phantom|solflare|backpack/i.test(wallet.name)) ?? candidates[0];

  if (!preferred) {
    throw new Error("no_solana_wallet_installed");
  }

  return preferred;
}

export function createWalletStandardPort(): SolanaWalletPort {
  let adapter: StandardWalletAdapter | null = null;
  const connection = new Connection(RPC_URL, "confirmed");

  const getAdapter = (): StandardWalletAdapter => {
    adapter ??= new StandardWalletAdapter({ wallet: pickWallet() });
    return adapter;
  };

  return {
    kind: "web-standard",
    async connect() {
      const currentAdapter = getAdapter();
      await currentAdapter.connect();

      if (!currentAdapter.publicKey) {
        throw new Error("wallet_connect_failed");
      }

      return {
        address: currentAdapter.publicKey.toBase58(),
        label: currentAdapter.name,
      };
    },
    async disconnect() {
      await adapter?.disconnect();
      adapter = null;
    },
    currentAddress() {
      return adapter?.publicKey?.toBase58() ?? null;
    },
    async signMessage(message) {
      const currentAdapter = getAdapter();

      if (!currentAdapter.signMessage) {
        throw new Error("wallet_sign_message_unsupported");
      }

      return currentAdapter.signMessage(message);
    },
    async signTransaction(txBase64) {
      const currentAdapter = getAdapter();

      if (!currentAdapter.signTransaction) {
        throw new Error("wallet_sign_transaction_unsupported");
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      const signedTx = await currentAdapter.signTransaction(tx);

      return Buffer.from(signedTx.serialize()).toString("base64");
    },
    async signAndSendTransaction(txBase64) {
      const currentAdapter = getAdapter();
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));

      return currentAdapter.sendTransaction(tx, connection, { skipPreflight: false });
    },
  };
}
