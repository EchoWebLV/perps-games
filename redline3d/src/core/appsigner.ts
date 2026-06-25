/** Wallet signing port. Defined now; signing stays dark until the money phase (Pillar F). */
export type SignerBackend = "dev-null" | "external-wallet" | "mwa-seedvault";

export interface AppSigner {
  readonly backend: SignerBackend;
  publicKey(): string | null;                    // base58; → @solana/kit Address at F
  signTransaction(tx: unknown): Promise<unknown>; // throws until F
  signMessage(m: Uint8Array): Promise<Uint8Array>;// throws until F
}

const dark = () => Promise.reject(new Error("signing enabled at the money phase"));

export function createNullSigner(): AppSigner {
  return { backend: "dev-null", publicKey: () => null, signTransaction: dark, signMessage: dark };
}

/** External wallet backend: exposes the connected address; signing stays dark until F. */
export function createExternalWalletSigner(address: string | null): AppSigner {
  return { backend: "external-wallet", publicKey: () => address, signTransaction: dark, signMessage: dark };
}
