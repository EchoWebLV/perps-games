import type { SolanaWalletPort } from "../core/solana-wallet";

/** The minimal island surface the port needs (privy-island.ts publishes this). */
export interface PrivyIsland {
  connect(): Promise<string>; // triggers Privy login, ensures an embedded wallet, returns its address
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(txBase64: string): Promise<string>;
  currentAddress(): string | null;
  reconnect(): Promise<string | null>; // silent restore of a persisted login; never opens the modal
  logout(): Promise<void>; // Privy sign-out — clears the auth session so the next connect() shows the login modal
}

/**
 * A SolanaWalletPort backed by a Privy embedded Solana wallet (via the React island).
 * Signing only — our send() (chain-round.ts) broadcasts — so signAndSendTransaction is omitted.
 */
export function createPrivyPort(deps: { island: PrivyIsland }): SolanaWalletPort {
  const { island } = deps;
  let address = "";
  return {
    kind: "web-standard",
    async connect() {
      address = await island.connect();
      return { address, label: "privy" };
    },
    async reconnect() {
      const a = await island.reconnect();
      if (!a) return null;
      address = a;
      return { address: a };
    },
    async disconnect() {
      address = "";
      await island.logout();
    },
    currentAddress() {
      return island.currentAddress() ?? (address || null);
    },
    async signMessage(message: Uint8Array) {
      return island.signMessage(message);
    },
    async signTransaction(txBase64: string) {
      return island.signTransaction(txBase64);
    },
  };
}
