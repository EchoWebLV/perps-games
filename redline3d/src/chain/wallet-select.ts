import { createDevKeypairPort } from "./dev-keypair-port";
import type { SolanaWalletPort } from "../core/solana-wallet";

/**
 * Pick the on-chain signer. Resolution order:
 *   1. `?wallet=dev|privy` URL param — runtime escape hatch so Claude Preview / automation
 *      can force the dev keypair without touching .env (and a Privy run can be forced anywhere).
 *   2. `VITE_WALLET` env (build-time pin).
 *   3. Default: **privy whenever a Privy app id is configured** — the player path — else dev-keypair.
 *
 * Returns synchronously so main.ts needs no async restructuring. For Privy, the React island
 * (react + @privy-io/react-auth) is dynamic-imported and mounted LAZILY on the first connect() —
 * keeping it out of the default bundle, and out of the path entirely when the dev keypair is picked.
 * game-session.init() awaits port.connect() before using the address, so the lazy mount lands
 * in time for portToAnchorWallet.
 */
export type WalletKind = "privy" | "dev";

export function resolveWalletKind(
  env: { VITE_WALLET?: string; VITE_PRIVY_APP_ID?: string },
  search: string,
): WalletKind {
  const param = new URLSearchParams(search).get("wallet");
  if (param === "dev" || param === "privy") return param;
  if (env.VITE_WALLET === "privy") return "privy";
  if (env.VITE_WALLET === "dev") return "dev";
  return env.VITE_PRIVY_APP_ID ? "privy" : "dev";
}

export function selectChainWalletPort(): SolanaWalletPort {
  const kind = resolveWalletKind(
    // exact member accesses — passing `import.meta.env` whole references the injected
    // bare-env object (EMPTY in some production chunks) instead of vite's static replacement
    {
      VITE_WALLET: import.meta.env.VITE_WALLET as string | undefined,
      VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID as string | undefined,
    },
    globalThis.location?.search ?? "",
  );
  if (kind === "privy") return createLazyPrivyPort();
  return createDevKeypairPort();
}

/** Privy persists its auth under `privy:`-prefixed localStorage keys — presence is the cheap
 *  "might still be logged in" probe that decides whether mounting the island is worth it. */
function hasPrivySession(): boolean {
  try {
    return Object.keys(globalThis.localStorage ?? {}).some((k) => k.startsWith("privy:"));
  } catch {
    return false;
  }
}

export function createLazyPrivyPort(deps: {
  load?: () => Promise<SolanaWalletPort>;
  hasPersistedSession?: () => boolean;
} = {}): SolanaWalletPort {
  let inner: SolanaWalletPort | null = null;
  let loading: Promise<SolanaWalletPort> | null = null;
  const load = deps.load ?? (async () => {
    const [{ mountPrivyIsland }, { createPrivyPort }] = await Promise.all([
      import("./privy-island"),
      import("./privy-wallet-port"),
    ]);
    return createPrivyPort({ island: await mountPrivyIsland() });
  });
  const hasPersistedSession = deps.hasPersistedSession ?? hasPrivySession;
  const ensure = (): Promise<SolanaWalletPort> => {
    if (inner) return Promise.resolve(inner);
    loading ??= (async () => {
      inner = await load();
      return inner;
    })();
    return loading;
  };
  return {
    kind: "web-standard",
    async connect() { return (await ensure()).connect(); },
    async reconnect() {
      // Boot-time silent restore. Skip mounting the island entirely unless Privy left a
      // session in localStorage — fresh visitors keep the react chunk out of their boot.
      if (!inner && !hasPersistedSession()) return null;
      const p = await ensure();
      return p.reconnect ? p.reconnect() : null;
    },
    async disconnect() {
      // Explicit logout must never trust the localStorage probe. Privy sessions can live in
      // cookies or IndexedDB, so mount the provider and ask Privy to clear its real auth state.
      await (await ensure()).disconnect();
    },
    currentAddress() { return inner?.currentAddress() ?? null; },
    async signMessage(message) { return (await ensure()).signMessage(message); },
    async signTransaction(txBase64) { return (await ensure()).signTransaction(txBase64); },
  };
}
