// React island — dynamic-imported ONLY when the Privy port is selected (wallet-select.ts). Uses
// createElement (NO JSX), so no @vitejs/plugin-react is needed. Privy SIGNS; our own send()
// (chain-round.ts) broadcasts via our RPC — so the provider needs NO RPC/cluster config, only
// embedded-wallet creation + `showWalletUIs:false` for ZERO-POPUP signing (the Task-0 spike's
// Option A). Exposes a tiny imperative facade the PrivyWalletPort consumes.
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useLogin, type PrivyClientConfig } from "@privy-io/react-auth";
import { useWallets, useSignMessage, useSignTransaction, useCreateWallet } from "@privy-io/react-auth/solana";

type SolanaChain = "solana:mainnet" | "solana:devnet" | "solana:testnet";
const CLUSTER: SolanaChain =
  (import.meta.env.VITE_SOLANA_CLUSTER as string) === "devnet" ? "solana:devnet" : "solana:mainnet";

/** The imperative surface the PrivyWalletPort consumes (see privy-wallet-port.ts). */
export interface PrivyIsland {
  /** Trigger Privy login (if needed), wait for the embedded wallet, resolve its address. */
  connect(): Promise<string>;
  /** Sign an account-binding challenge with the embedded Solana wallet. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Sign a wire tx (base64) with the embedded wallet; resolves the signed wire tx (base64). */
  signTransaction(txBase64: string): Promise<string>;
  currentAddress(): string | null;
  /** Silent restore: resolve the address if Privy is ALREADY authenticated (persisted session),
   *  null otherwise. Never opens the login modal. */
  reconnect(): Promise<string | null>;
  /** Privy sign-out: clears the auth session so the next connect() shows the login modal. */
  logout(): Promise<void>;
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
  logout: () => Promise<void>;
  createWallet: (() => Promise<unknown>) | null;
  address: string | null;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  sign: ((txBase64: string) => Promise<string>) | null;
}
let live: Live = {
  ready: false,
  authenticated: false,
  login: () => {},
  logout: async () => {},
  createWallet: null,
  address: null,
  signMessage: null,
  sign: null,
};
let resolveReady: (() => void) | null = null;
// Login-flow terminal error published by useLogin's onError — 'exited_auth_flow' = the player
// closed the modal. Without it connect() has NO dismissal signal and blind-polls for 3 minutes.
let loginError: string | null = null;

// Renders nothing — Privy's login UI is a portalled modal. The effect publishes the freshest
// state + a wallet-bound signer to `live` after every render.
function Bridge() {
  const p = usePrivy();
  const { login } = useLogin({
    onComplete: () => { loginError = null; },
    onError: (code) => { loginError = String(code); },
  });
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { createWallet } = useCreateWallet();
  // Pick the EMBEDDED wallet explicitly — index 0 is Privy-first only by implementation
  // accident, and would become an external wallet if connectors are ever enabled.
  const wallet =
    wallets.find((w) => (w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet) ??
    wallets[0] ?? null;
  useEffect(() => {
    live = {
      ready: p.ready,
      authenticated: p.authenticated,
      login: () => login(),
      logout: () => p.logout(),
      createWallet: () => createWallet(),
      address: wallet?.address ?? null,
      signMessage: wallet
        ? async (message: Uint8Array) => {
            const signed = await signMessage({
              message,
              wallet,
              options: { uiOptions: { showWalletUIs: false } },
            });
            return signed.signature;
          }
        : null,
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
      loginError = null;
      live.login(); // opens the Privy login modal (email/social)
      // The clock includes the player's OWN pace — opening their inbox, reading the OTP —
      // so it must be generous. Modal dismissal is caught by onError('exited_auth_flow')
      // above; this only backstops a zombie modal nobody is looking at. 180s once expired
      // mid-OTP on a real login (the auth SUCCEEDED — we just stopped listening).
      await waitFor(() => live.authenticated || loginError !== null, 900_000, "privy_login_timeout");
      if (loginError !== null) {
        const code = loginError;
        loginError = null;
        throw new Error(code === "exited_auth_flow" ? "privy_login_cancelled" : `privy_login_failed:${code}`);
      }
    }
    // createOnLogin:'users-without-wallets' provisions the embedded wallet right after login —
    // but ONLY for accounts with no wallet at all. An account that already carries some other
    // wallet (linked external / EVM embedded) logs in fine yet never gets a Solana wallet, so
    // if none appears quickly, provision one explicitly and keep waiting.
    try {
      await waitFor(() => !!live.address, 8_000, "provision_needed");
    } catch {
      await live.createWallet?.().catch(() => { /* already exists / races the auto-create */ });
    }
    await waitFor(() => !!live.address, 60_000, "privy_wallet_timeout");
    return live.address!;
  },
  async signTransaction(txBase64: string) {
    if (!live.sign) throw new Error("privy_wallet_not_ready");
    return live.sign(txBase64);
  },
  async signMessage(message: Uint8Array) {
    if (!live.signMessage) throw new Error("privy_wallet_not_ready");
    return live.signMessage(message);
  },
  currentAddress() {
    return live.address;
  },
  async reconnect() {
    if (!live.authenticated) return null; // no persisted session — stay silent, no modal
    await waitFor(() => !!live.address, 20_000, "privy_wallet_timeout").catch(() => {});
    return live.address;
  },
  async logout() {
    if (!live.authenticated) return;
    await live.logout(); // usePrivy().logout resolves once the session is cleared
    await waitFor(() => !live.authenticated, 15_000, "privy_logout_timeout");
  },
};

let mountPromise: Promise<PrivyIsland> | null = null;
let rootMounted = false;
/** Mount the PrivyProvider React root once and resolve the facade as soon as Privy is ready.
 *  Rejects (and allows retry) if Privy never becomes ready — a wrong app id or an origin missing
 *  from the Privy dashboard allowlist would otherwise hang the sign-in gate forever. */
export function mountPrivyIsland(): Promise<PrivyIsland> {
  if (mountPromise) return mountPromise;
  // exact member access (no `?.`) — vite only statically replaces the literal
  // `import.meta.env.VITE_*` form; optional chaining falls back to the injected
  // bare-env object, which ships EMPTY in some production chunks
  const appId = import.meta.env.VITE_PRIVY_APP_ID as string;
  if (!appId) return Promise.reject(new Error("VITE_PRIVY_APP_ID not set"));
  mountPromise = new Promise<PrivyIsland>((resolve, reject) => {
    if (live.ready) { resolve(facade); return; } // re-entry after a slow first mount
    const t = setTimeout(() => {
      mountPromise = null; // let a later Sign-in tap retry (the provider may come up late)
      resolveReady = null;
      reject(new Error("privy_unreachable — check VITE_PRIVY_APP_ID + the app's allowed origins"));
    }, 25_000);
    resolveReady = () => { clearTimeout(t); resolve(facade); };
    if (!rootMounted) {
      rootMounted = true;
      const host = document.createElement("div");
      host.id = "privy-root";
      document.body.appendChild(host);
      // Inside the Capacitor WebView (Seeker APK) social OAuth is blocked upstream
      // (disallowed_useragent), so pin login to the in-page email OTP there — the one
      // WebView-safe method. On the web the dashboard's full method list stays in charge.
      // Runtime-gated: web and APK ship the same bundle; only the APK injects Capacitor.
      const native = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
      const config: PrivyClientConfig = {
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        ...(native ? { loginMethods: ["email"] as PrivyClientConfig["loginMethods"] } : {}),
      };
      createRoot(host).render(createElement(PrivyProvider, { appId, config, children: createElement(Bridge) }));
    }
  });
  return mountPromise;
}
