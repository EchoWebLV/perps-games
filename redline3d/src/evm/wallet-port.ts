/**
 * The client's EVM signer port. Deliberately NOT `SolanaWalletPort`: message signing here is
 * string-in / 0x-hex-out (EIP-191), and value movement is an ERC-20 transfer rather than a
 * serialized transaction round-trip. Both the Privy adapter and the dev twin implement it, so
 * the game code above never learns which one it got.
 */
export interface EvmWalletPort {
  kind: "privy-evm" | "dev-evm";
  connect(): Promise<{ address: string }>;
  /** Silent session restore: resolve the address ONLY if a login already exists (never shows a
   *  login UI); null when there is nothing to restore. */
  reconnect(): Promise<{ address: string } | null>;
  disconnect(): Promise<void>;
  currentAddress(): string | null;
  /** EIP-191 personal_sign over the UTF-8 message; resolves the 65-byte signature as 0x-hex. */
  signMessage(message: string): Promise<string>;
  /** ERC-20 USDC transfer to `to`; resolves the tx hash. */
  sendUsdcTransfer(to: string, amountBaseUnits: bigint): Promise<string>;
  /** wallet's own USDC balance in base units (cashier display), null if unreadable. */
  usdcBalance(): Promise<bigint | null>;
}
