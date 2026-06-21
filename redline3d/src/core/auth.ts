export interface AuthProvider {
  ready(): Promise<void>;                 // resolves once an identity exists (privy: after login)
  userId(): string;                       // dev: web-<uuid> · privy: did:privy:<sub>
  authHeaders(): Promise<Record<string, string>>; // dev: {x-dev-user} · privy: {authorization: Bearer <jwt>} (async — the JWT refreshes)
  login?(): void;
  logout?(): Promise<void>;
  walletPublicKey?(): string | null;
}
