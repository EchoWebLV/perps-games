import { createDevKeypairPort } from "./dev-keypair-port";
import type { SolanaWalletPort } from "../core/solana-wallet";

/**
 * Pick the on-chain signer by build config. Dev-keypair is the DEFAULT (Preview/tests/automation);
 * `VITE_WALLET=privy` selects the Privy embedded wallet.
 *
 * Returns synchronously so main.ts needs no async restructuring. For Privy, the React island
 * (react + @privy-io/react-auth) is dynamic-imported and mounted LAZILY on the first connect() —
 * keeping it out of the default bundle, and out of the path entirely unless VITE_WALLET=privy.
 * game-session.init() awaits port.connect() before using the address, so the lazy mount lands
 * in time for portToAnchorWallet.
 */
export function selectChainWalletPort(): SolanaWalletPort {
  if (import.meta.env?.VITE_WALLET === "privy") return createLazyPrivyPort();
  return createDevKeypairPort();
}

function createLazyPrivyPort(): SolanaWalletPort {
  let inner: SolanaWalletPort | null = null;
  let loading: Promise<SolanaWalletPort> | null = null;
  const ensure = (): Promise<SolanaWalletPort> => {
    if (inner) return Promise.resolve(inner);
    loading ??= (async () => {
      const [{ mountPrivyIsland }, { createPrivyPort }] = await Promise.all([
        import("./privy-island"),
        import("./privy-wallet-port"),
      ]);
      inner = createPrivyPort({ island: await mountPrivyIsland() });
      return inner;
    })();
    return loading;
  };
  return {
    kind: "web-standard",
    async connect() { return (await ensure()).connect(); },
    async disconnect() { if (inner) await inner.disconnect(); },
    currentAddress() { return inner?.currentAddress() ?? null; },
    async signMessage(message) { return (await ensure()).signMessage(message); },
    async signTransaction(txBase64) { return (await ensure()).signTransaction(txBase64); },
  };
}
