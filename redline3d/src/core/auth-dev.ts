import type { AuthProvider } from "./auth";
import { getDevUserId, type KvStore } from "./identity";

export function createDevAuth(store?: KvStore): AuthProvider {
  const user = getDevUserId(store);
  return {
    async ready() {},
    userId: () => user,
    async authHeaders() { return { "x-dev-user": user }; },
    async logout() {},
  };
}
