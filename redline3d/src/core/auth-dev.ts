import type { AuthProvider } from "./auth";
import { getDevUserId, type KvStore } from "./identity";

export function createDevAuth(store?: KvStore): AuthProvider {
  const id = getDevUserId(store);
  return {
    async ready() {},
    userId: () => id,
    async authHeaders() { return { "x-dev-user": id }; },
    walletPublicKey: () => null,
    async signTransaction(): Promise<string> { throw new Error("signing requires a Privy wallet"); },
    async signAndSendTransaction(): Promise<string> { throw new Error("signing requires a Privy wallet"); },
  };
}
