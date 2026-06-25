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

function pickWallet(): WalletAdapterCompatibleStandardWallet | null {
  const wallets = getWallets().get() as readonly WalletAdapterCompatibleStandardWallet[];
  const candidates = wallets.filter(supportsSolanaChain);
  return (
    candidates.find((wallet) => /phantom|solflare|backpack/i.test(wallet.name)) ?? candidates[0] ?? null
  );
}

interface LegacySolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  name?: string;
  publicKey?: unknown;
  connect(): Promise<{ publicKey?: unknown } | void>;
  disconnect?(): Promise<void>;
  signMessage?(
    message: Uint8Array,
    display?: string,
  ): Promise<Uint8Array | { signature: Uint8Array | number[] }>;
  signTransaction?(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signAndSendTransaction?(tx: VersionedTransaction): Promise<string | { signature: string }>;
}

function publicKeyToAddress(publicKey: unknown): string | null {
  if (!publicKey) return null;
  if (typeof publicKey === "string") return publicKey;
  const maybeKey = publicKey as { toBase58?: () => string; toString?: () => string };
  if (typeof maybeKey.toBase58 === "function") return maybeKey.toBase58();
  if (typeof maybeKey.toString === "function") return maybeKey.toString();
  return null;
}

function legacyLabel(provider: LegacySolanaProvider): string {
  if (provider.name) return provider.name;
  if (provider.isPhantom) return "Phantom";
  if (provider.isSolflare) return "Solflare";
  if (provider.isBackpack) return "Backpack";
  return "Solana Wallet";
}

function pickLegacyProvider(): LegacySolanaProvider | null {
  const g = globalThis as typeof globalThis & {
    phantom?: { solana?: LegacySolanaProvider };
    solana?: LegacySolanaProvider;
    solflare?: LegacySolanaProvider;
    backpack?: LegacySolanaProvider | { solana?: LegacySolanaProvider };
  };
  const raw = [
    g.phantom?.solana,
    g.solana,
    g.solflare,
    "solana" in (g.backpack ?? {})
      ? (g.backpack as { solana?: LegacySolanaProvider }).solana
      : (g.backpack as LegacySolanaProvider | undefined),
  ];
  const seen = new Set<LegacySolanaProvider>();
  const candidates = raw.filter((provider): provider is LegacySolanaProvider => {
    if (!provider || typeof provider.connect !== "function" || seen.has(provider)) return false;
    seen.add(provider);
    return true;
  });
  return (
    candidates.find((provider) => provider.isPhantom) ??
    candidates.find((provider) => provider.isSolflare) ??
    candidates.find((provider) => provider.isBackpack) ??
    candidates[0] ??
    null
  );
}

function signatureBytes(signature: Uint8Array | number[]): Uint8Array {
  return signature instanceof Uint8Array ? signature : new Uint8Array(signature);
}

export function createWalletStandardPort(): SolanaWalletPort {
  let adapter: StandardWalletAdapter | null = null;
  let legacyProvider: LegacySolanaProvider | null = null;
  let active: "standard" | "legacy" | null = null;
  const connection = new Connection(RPC_URL, "confirmed");

  const getStandardAdapter = (): StandardWalletAdapter | null => {
    if (adapter) return adapter;
    const wallet = pickWallet();
    if (!wallet) return null;
    adapter = new StandardWalletAdapter({ wallet });
    return adapter;
  };
  const getLegacyProvider = (): LegacySolanaProvider | null => {
    legacyProvider ??= pickLegacyProvider();
    return legacyProvider;
  };
  const requireConnectedProvider = ():
    | { type: "standard"; adapter: StandardWalletAdapter }
    | { type: "legacy"; provider: LegacySolanaProvider } => {
    if (active === "standard" && adapter) return { type: "standard", adapter };
    if (active === "legacy" && legacyProvider) return { type: "legacy", provider: legacyProvider };
    const standardAdapter = getStandardAdapter();
    if (standardAdapter) {
      active = "standard";
      return { type: "standard", adapter: standardAdapter };
    }
    const provider = getLegacyProvider();
    if (provider) {
      active = "legacy";
      return { type: "legacy", provider };
    }
    throw new Error("no_solana_wallet_installed");
  };

  return {
    kind: "web-standard",
    async connect() {
      const current = requireConnectedProvider();
      if (current.type === "standard") {
        await current.adapter.connect();

        if (!current.adapter.publicKey) {
          throw new Error("wallet_connect_failed");
        }

        return {
          address: current.adapter.publicKey.toBase58(),
          label: current.adapter.name,
        };
      }

      const connected = await current.provider.connect();
      const address = publicKeyToAddress(connected?.publicKey ?? current.provider.publicKey);
      if (!address) throw new Error("wallet_connect_failed");
      return {
        address,
        label: legacyLabel(current.provider),
      };
    },
    async disconnect() {
      await adapter?.disconnect();
      await legacyProvider?.disconnect?.();
      adapter = null;
      legacyProvider = null;
      active = null;
    },
    currentAddress() {
      if (active === "legacy") return publicKeyToAddress(legacyProvider?.publicKey) ?? null;
      return adapter?.publicKey?.toBase58() ?? null;
    },
    async signMessage(message) {
      const current = requireConnectedProvider();
      if (current.type === "legacy") {
        if (!current.provider.signMessage) {
          throw new Error("wallet_sign_message_unsupported");
        }
        const signed = await current.provider.signMessage(message, "utf8");
        return signed instanceof Uint8Array ? signed : signatureBytes(signed.signature);
      }

      if (!current.adapter.signMessage) {
        throw new Error("wallet_sign_message_unsupported");
      }

      return current.adapter.signMessage(message);
    },
    async signTransaction(txBase64) {
      const current = requireConnectedProvider();
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      if (current.type === "legacy") {
        if (!current.provider.signTransaction) {
          throw new Error("wallet_sign_transaction_unsupported");
        }
        const signedTx = await current.provider.signTransaction(tx);
        return Buffer.from(signedTx.serialize()).toString("base64");
      }

      if (!current.adapter.signTransaction) {
        throw new Error("wallet_sign_transaction_unsupported");
      }

      const signedTx = await current.adapter.signTransaction(tx);

      return Buffer.from(signedTx.serialize()).toString("base64");
    },
    async signAndSendTransaction(txBase64) {
      const current = requireConnectedProvider();
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      if (current.type === "legacy") {
        if (current.provider.signAndSendTransaction) {
          const res = await current.provider.signAndSendTransaction(tx);
          return typeof res === "string" ? res : res.signature;
        }
        if (!current.provider.signTransaction) {
          throw new Error("wallet_sign_transaction_unsupported");
        }
        const signedTx = await current.provider.signTransaction(tx);
        return connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
      }

      return current.adapter.sendTransaction(tx, connection, { skipPreflight: false });
    },
  };
}
