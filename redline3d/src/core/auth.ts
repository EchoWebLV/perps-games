export interface AuthProvider {
  ready(): Promise<void>;                 // resolves once an identity exists (privy: after login)
  userId(): string;                       // dev: web-<uuid> · privy: did:privy:<sub>
  authHeaders(): Promise<Record<string, string>>; // dev: {x-dev-user} · privy: Bearer JWT + selected wallet (async: JWT refreshes)
  login?(): void;
  logout?(): Promise<void>;
  walletPublicKey?(): string | null;
  /** sign + broadcast a server-built tx (base64); resolves to the signature string. privy-only. */
  signAndSend(txBase64: string): Promise<string>;
}
