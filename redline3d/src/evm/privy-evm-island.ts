// React island — dynamic-imported ONLY when the Privy EVM port is selected (evm/rail.ts). Uses
// createElement (NO JSX), so no @vitejs/plugin-react is needed. The EVM twin of
// chain/privy-island.ts: same Bridge/facade/mount shape, but every wallet action goes through the
// embedded wallet's EIP-1193 provider (`getEthereumProvider`) rather than Privy's Solana hooks —
// the provider surface is the stable one across Privy versions. `showWalletUIs:false` keeps
// signing and sending popup-free.
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useLogin,
  useWallets,
  useCreateWallet,
  getEmbeddedConnectedWallet,
  type ConnectedWallet,
  type PrivyClientConfig,
} from "@privy-io/react-auth";
import { EVM_CHAIN, EVM_USDC } from "./chain";
import { buildPersonalSignParams, buildUsdcTransferTx, ensureChain } from "./eip1193";

/** The imperative surface the Privy EVM port consumes (see privy-evm-port.ts). */
export interface PrivyEvmIsland {
  /** Trigger Privy login (if needed), wait for the embedded EVM wallet, resolve its address. */
  connect(): Promise<string>;
  /** EIP-191 personal_sign over the UTF-8 message; resolves the 0x-hex signature. */
  signMessage(message: string): Promise<string>;
  /** ERC-20 USDC transfer from the embedded wallet; resolves the tx hash. */
  sendUsdcTransfer(to: string, amountBaseUnits: bigint): Promise<string>;
  currentAddress(): string | null;
  /** Silent restore: resolve the address if Privy is ALREADY authenticated (persisted session),
   *  null otherwise. Never opens the login modal. */
  reconnect(): Promise<string | null>;
  /** Privy sign-out: clears the auth session so the next connect() shows the login modal. */
  logout(): Promise<void>;
}

// `utf8ToHex`, `ensureChain` and the two payload builders live in ./eip1193 — this module's
// top-level react/@privy-io imports make it unimportable from a test process, and the bytes that
// decide where a player's money goes must be covered by tests. Nothing money-shaped is built here.

// Latest live Privy state, kept fresh by the React bridge's effect; the imperative facade reads it.
interface Live {
  ready: boolean;
  authenticated: boolean;
  login: () => void;
  logout: () => Promise<void>;
  createWallet: (() => Promise<unknown>) | null;
  address: string | null;
  signMessage: ((message: string) => Promise<string>) | null;
  sendUsdc: ((to: string, amountBaseUnits: bigint) => Promise<string>) | null;
}
let live: Live = {
  ready: false,
  authenticated: false,
  login: () => {},
  logout: async () => {},
  createWallet: null,
  address: null,
  signMessage: null,
  sendUsdc: null,
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
  const { createWallet } = useCreateWallet();
  // EMBEDDED OR NOTHING. There is deliberately no `wallets[0]` fallback: any wallet that both of
  // these probes miss is by definition not the Privy embedded one (a linked MetaMask, say), and
  // accepting it would publish an external address that connect()'s `!!live.address` wait then
  // treats as success — the createWallet() provisioning branch never fires, and the player binds
  // and funds a wallet this app cannot sign for. Null instead lets connect() provision properly.
  const wallet: ConnectedWallet | null =
    getEmbeddedConnectedWallet(wallets) ?? wallets.find((w) => w.walletClientType === "privy") ?? null;
  useEffect(() => {
    live = {
      ready: p.ready,
      authenticated: p.authenticated,
      login: () => login(),
      logout: () => p.logout(),
      createWallet: () => createWallet(),
      address: wallet?.address ?? null,
      signMessage: wallet
        ? async (message: string) => {
            const provider = await wallet.getEthereumProvider();
            return (await provider.request({
              method: "personal_sign",
              params: buildPersonalSignParams(message, wallet.address),
            })) as string;
          }
        : null,
      sendUsdc: wallet
        ? async (to: string, amountBaseUnits: bigint) => {
            // Built (and guarded: lowercased recipient, no burn to 0x0, chainId pinned into the
            // payload) before the provider is even touched — see ./eip1193.
            const tx = buildUsdcTransferTx({
              from: wallet.address,
              to,
              usdc: EVM_USDC,
              amountBaseUnits,
              chainId: EVM_CHAIN.id,
            });
            const provider = await wallet.getEthereumProvider();
            await ensureChain(provider, EVM_CHAIN.id);
            return (await provider.request({
              method: "eth_sendTransaction",
              params: [tx],
            })) as string;
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

const facade: PrivyEvmIsland = {
  async connect() {
    if (!live.authenticated) {
      loginError = null;
      live.login(); // opens the Privy login modal (email/social)
      await waitFor(() => live.authenticated || loginError !== null, 180_000, "privy_login_timeout");
      if (loginError !== null) {
        const code = loginError;
        loginError = null;
        throw new Error(code === "exited_auth_flow" ? "privy_login_cancelled" : `privy_login_failed:${code}`);
      }
    }
    // createOnLogin:'users-without-wallets' provisions the embedded wallet right after login —
    // but ONLY for accounts with no wallet at all. An account that already carries some other
    // wallet (linked external / Solana embedded) logs in fine yet never gets an EVM wallet, so
    // if none appears quickly, provision one explicitly and keep waiting.
    try {
      await waitFor(() => !!live.address, 8_000, "provision_needed");
    } catch {
      await live.createWallet?.().catch(() => { /* already exists / races the auto-create */ });
    }
    await waitFor(() => !!live.address, 60_000, "privy_wallet_timeout");
    return live.address!;
  },
  async signMessage(message: string) {
    if (!live.signMessage) throw new Error("privy_wallet_not_ready");
    return live.signMessage(message);
  },
  async sendUsdcTransfer(to: string, amountBaseUnits: bigint) {
    if (!live.sendUsdc) throw new Error("privy_wallet_not_ready");
    return live.sendUsdc(to, amountBaseUnits);
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

let mountPromise: Promise<PrivyEvmIsland> | null = null;
let rootMounted = false;
/** Mount the PrivyProvider React root once and resolve the facade as soon as Privy is ready.
 *  Rejects (and allows retry) if Privy never becomes ready — a wrong app id or an origin missing
 *  from the Privy dashboard allowlist would otherwise hang the sign-in gate forever. */
export function mountPrivyEvmIsland(): Promise<PrivyEvmIsland> {
  if (mountPromise) return mountPromise;
  // exact member access (no `?.`) — vite only statically replaces the literal
  // `import.meta.env.VITE_*` form; optional chaining falls back to the injected
  // bare-env object, which ships EMPTY in some production chunks
  const appId = import.meta.env.VITE_PRIVY_APP_ID as string;
  if (!appId) return Promise.reject(new Error("VITE_PRIVY_APP_ID not set"));
  mountPromise = new Promise<PrivyEvmIsland>((resolve, reject) => {
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
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        // Pin the embedded wallet to Robinhood Chain: with a single supported chain Privy has
        // nowhere else to put it, so sends land here without a per-tx switch prompt.
        supportedChains: [EVM_CHAIN],
        defaultChain: EVM_CHAIN,
        ...(native ? { loginMethods: ["email"] as PrivyClientConfig["loginMethods"] } : {}),
      };
      createRoot(host).render(createElement(PrivyProvider, { appId, config, children: createElement(Bridge) }));
    }
  });
  return mountPromise;
}
