export interface AuthProvider {
  ready(): Promise<void>;
  userId(): string;
  authHeaders(): Promise<Record<string, string>>;
  adoptSession?(session: { token: string; userId: string }): void;
  invalidateSession?(): void;
  logout?(): Promise<void>;
}
