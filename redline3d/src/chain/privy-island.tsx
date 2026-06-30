// React island — dynamic-imported ONLY under VITE_WALLET=privy (wallet-select.ts). Uses
// createElement (NO JSX), so no @vitejs/plugin-react is needed. Privy SIGNS; our own send()
// (chain-round.ts) broadcasts via our RPC — so the provider needs NO RPC/cluster config, only
// embedded-wallet creation + `showWalletUIs:false` for ZERO-POPUP signing (the Task-0 spike's
// Option A). Exposes a tiny imperative facade the PrivyWalletPort consumes.
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, type PrivyClientConfig } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";

type SolanaChain = "solana:mainnet" | "solana:devnet" | "solana:testnet";
const CLUSTER: SolanaChain =
  (import.meta.env?.VITE_SOLANA_CLUSTER as string) === "devnet" ? "solana:devnet" : "solana:mainnet";

/** The imperative surface the PrivyWalletPort consumes (see privy-wallet-port.ts). */
export interface PrivyIsland {
  /** Trigger Privy login (if needed), wait for the embedded wallet, resolve its address. */
  connect(): Promise<string>;
  /** Sign a wire tx (base64) with the embedded wallet; resolves the signed wire tx (base64). */
  signTransaction(txBase64: string): Promise<string>;
  currentAddress(): string | null;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// Latest live Privy state, kept fresh by the React bridge's effect; the imperative facade reads it.
interface Live {
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  address: string | null;
  sign: ((txBase64: string) => Promise<string>) | null;
}
let live: Live = { ready: false, authenticated: false, login: () => {}, address: null, sign: null };
let resolveReady: (() => void) | null = null;

// Renders nothing — Privy's login UI is a portalled modal. The effect publishes the freshest
// state + a wallet-bound signer to `live` after every render.
function Bridge() {
  const p = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = wallets[0] ?? null;
  useEffect(() => {
    live = {
      ready: p.ready,
      authenticated: p.authenticated,
      login: () => p.login(),
      address: wallet?.address ?? null,
      sign: wallet
        ? async (txBase64: string) => {
            const { signedTransaction } = await signTransaction({
              transaction: base64ToBytes(txBase64),
              wallet,
              chain: CLUSTER,
            });
            return bytesToBase64(signedTransaction);
          }
        : null,
    };
    if (p.ready && resolveReady) {
      resolveReady();
      resolveReady = null;
    }
  });
  return null;
}

async function waitFor(cond: () => boolean, timeoutMs: number, errCode: string): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error(errCode);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const facade: PrivyIsland = {
  async connect() {
    if (!live.authenticated) {
      live.login(); // opens the Privy login modal (email/social)
      await waitFor(() => live.authenticated, 180_000, "privy_login_timeout");
    }
    // createOnLogin:'users-without-wallets' provisions the embedded wallet right after login.
    await waitFor(() => !!live.address, 60_000, "privy_wallet_timeout");
    return live.address!;
  },
  async signTransaction(txBase64: string) {
    if (!live.sign) throw new Error("privy_wallet_not_ready");
    return live.sign(txBase64);
  },
  currentAddress() {
    return live.address;
  },
};

let mountPromise: Promise<PrivyIsland> | null = null;
/** Mount the PrivyProvider React root once and resolve the facade as soon as Privy is ready. */
export function mountPrivyIsland(): Promise<PrivyIsland> {
  if (mountPromise) return mountPromise;
  const appId = import.meta.env?.VITE_PRIVY_APP_ID as string;
  if (!appId) return Promise.reject(new Error("VITE_PRIVY_APP_ID not set"));
  mountPromise = new Promise<PrivyIsland>((resolve) => {
    resolveReady = () => resolve(facade);
    const host = document.createElement("div");
    host.id = "privy-root";
    document.body.appendChild(host);
    const config: PrivyClientConfig = {
      embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
    };
    createRoot(host).render(createElement(PrivyProvider, { appId, config, children: createElement(Bridge) }));
  });
  return mountPromise;
}
