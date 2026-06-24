export interface AuthProvider {
  ready(): Promise<void>;                 // resolves once an identity exists (privy: after login)
  userId(): string;                       // dev: web-<uuid> · privy: did:privy:<sub>
  authHeaders(): Promise<Record<string, string>>; // dev: {x-dev-user} · privy: Bearer JWT + selected wallet (async: JWT refreshes)
  login?(): void;
  logout?(): Promise<void>;
  walletPublicKey?(): string | null;
  /** sign a server-built tx (base64); resolves to the signed wire tx base64. privy-only. */
  signTransaction(txBase64: string): Promise<string>;
  /** sign + send a server-built tx (base64); resolves to the Solana signature string. privy-only. */
  signAndSendTransaction(txBase64: string): Promise<string>;
}
