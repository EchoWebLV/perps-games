// React island — dynamic-imported ONLY under VITE_AUTH=privy. createElement (no JSX) → no react plugin.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";

export interface PrivySnapshot {
  ready: boolean;
  authenticated: boolean;
  did: string | null;
  login: () => void;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  walletAddress: string | null;
}

function Bridge(props: { onState: (s: PrivySnapshot) => void }) {
  const p = usePrivy() as any;
  const wallet = (p.user?.linkedAccounts ?? []).find(
    (a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
  );
  props.onState({
    ready: p.ready, authenticated: p.authenticated, did: p.user?.id ?? null,
    login: p.login, logout: p.logout, getAccessToken: p.getAccessToken,
    walletAddress: wallet?.address ?? null,
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
