import type { SolanaWalletPort } from "../core/solana-wallet";

/** The minimal island surface the port needs (privy-island.tsx publishes this). */
export interface PrivyIsland {
  connect(): Promise<string>; // triggers Privy login, ensures an embedded wallet, returns its address
  signTransaction(txBase64: string): Promise<string>;
  currentAddress(): string | null;
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
    async disconnect() {
      /* island owns logout (wallet panel); nothing to tear down here */
    },
    currentAddress() {
      return island.currentAddress() ?? (address || null);
    },
    async signMessage() {
      throw new Error("privy_sign_message_unsupported");
    },
    async signTransaction(txBase64: string) {
      return island.signTransaction(txBase64);
    },
  };
}
