// React island — dynamic-imported ONLY under VITE_AUTH=privy. createElement (no JSX) → no react plugin.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignAndSendTransaction } from "@privy-io/react-auth/solana";

export interface PrivySnapshot {
  ready: boolean;
  authenticated: boolean;
  did: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  walletAddress: string | null;
  /** sign + broadcast a server-built tx (base64). Resolves to the signature (base58). */
  signAndSend: (txBase64: string) => Promise<string>;
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

function Bridge(props: { onState: (s: PrivySnapshot) => void }) {
  const p = usePrivy() as any;
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = (p.user?.linkedAccounts ?? []).find(
    (a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
  );
  const signAndSend = async (txBase64: string): Promise<string> => {
    // prefer the wallet matching the embedded solana account; else the first connected wallet
    const sol = wallets.find((w) => w.address === wallet?.address) ?? wallets[0];
    if (!sol) throw new Error("no wallet");
    const transaction = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
    const { signature } = await signAndSendTransaction({ transaction, wallet: sol, chain: "solana:mainnet" });
    return base58(signature); // display/log only — the server confirmer credits independently
  };
  props.onState({
    ready: p.ready, authenticated: p.authenticated, did: p.user?.id ?? null,
    login: p.login, logout: p.logout, getAccessToken: p.getAccessToken,
    walletAddress: wallet?.address ?? null,
    signAndSend,
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
      config: { embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } } },
      children: createElement(Bridge, { onState }),
    }),
  );
}
