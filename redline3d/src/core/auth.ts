export interface AuthProvider {
  ready(): Promise<void>;
  userId(): string;
  authHeaders(): Promise<Record<string, string>>;
  logout?(): Promise<void>;
}
