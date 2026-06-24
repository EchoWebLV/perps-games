// React island — dynamic-imported ONLY under VITE_AUTH=privy. createElement (no JSX) → no react plugin.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignAndSendTransaction, useSignTransaction } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const SOLANA_CHAIN = import.meta.env?.VITE_SOLANA_CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";

function solanaRpcs(appId: string) {
  const encodedAppId = encodeURIComponent(appId);
  return {
    "solana:mainnet": {
      rpc: createSolanaRpc(`https://solana-mainnet.rpc.privy.systems?privyAppId=${encodedAppId}`),
      rpcSubscriptions: createSolanaRpcSubscriptions(`wss://solana-mainnet.rpc.privy.systems?privyAppId=${encodedAppId}`),
    },
    "solana:devnet": {
      rpc: createSolanaRpc(`https://solana-devnet.rpc.privy.systems?privyAppId=${encodedAppId}`),
      rpcSubscriptions: createSolanaRpcSubscriptions(`wss://solana-devnet.rpc.privy.systems?privyAppId=${encodedAppId}`),
    },
  };
}

export interface PrivySnapshot {
  ready: boolean;
  authenticated: boolean;
  did: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  walletAddress: string | null;
  /** sign a server-built tx (base64). Resolves to the signed wire tx base64. */
  signTransaction: (txBase64: string) => Promise<string>;
  /** sign + send a server-built tx (base64). Resolves to the transaction signature. */
  signAndSendTransaction: (txBase64: string) => Promise<string>;
}

// minimal base58 encoder (Bitcoin alphabet) for a signature byte array → display string
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function base64ToBytes(txBase64: string): Uint8Array {
  return Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function Bridge(props: { onState: (s: PrivySnapshot) => void }) {
  const p = usePrivy() as any;
  const { wallets } = useWallets();
  const { signTransaction: privySignTransaction } = useSignTransaction();
  const { signAndSendTransaction: privySignAndSendTransaction } = useSignAndSendTransaction();
  const wallet = (p.user?.linkedAccounts ?? []).find(
    (a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
  );
  const signTransaction = async (txBase64: string): Promise<string> => {
    const sol = wallets.find((w) => w.address === wallet?.address);
    if (!sol) throw new Error("no wallet");
    const transaction = base64ToBytes(txBase64);
    const { signedTransaction } = await privySignTransaction({ transaction, wallet: sol, chain: SOLANA_CHAIN });
    return bytesToBase64(signedTransaction);
  };
  const signAndSendTransaction = async (txBase64: string): Promise<string> => {
    const sol = wallets.find((w) => w.address === wallet?.address);
    if (!sol) throw new Error("no wallet");
    const transaction = base64ToBytes(txBase64);
    const { signature } = await privySignAndSendTransaction({
      transaction,
      wallet: sol,
      chain: SOLANA_CHAIN,
    });
    return base58(signature);
  };
  props.onState({
    ready: p.ready, authenticated: p.authenticated, did: p.user?.id ?? null,
    login: p.login, logout: p.logout, getAccessToken: p.getAccessToken,
    walletAddress: wallet?.address ?? null,
    signTransaction,
    signAndSendTransaction,
  });
  return null; // Privy's login UI is a portalled modal; the bridge renders nothing inline
}

let root: Root | null = null;
export function mountPrivy(appId: string, onState: (s: PrivySnapshot) => void): void {
  if (root) return;
  const host = document.createElement("div");
  host.id = "privy-root";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    // v3's PrivyProviderProps types `children` as a required prop, so pass it in the props
    // object rather than relying on createElement's third (children) argument.
    createElement(PrivyProvider, {
      appId,
      config: {
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        solana: {
          rpcs: solanaRpcs(appId),
        },
      },
      children: createElement(Bridge, { onState }),
    }),
  );
}
