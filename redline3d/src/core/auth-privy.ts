import type { AuthProvider } from "./auth";
import type { PrivySnapshot } from "./privy-island";

/** Privy-backed AuthProvider. Lazy-imports the React island so the default build ships no React. */
export function createPrivyAuth(appId: string): AuthProvider {
  let snap: PrivySnapshot | null = null;
  let resolveReady!: () => void;
  const readyP = new Promise<void>((r) => (resolveReady = r));

  void (async () => {
    const { mountPrivy } = await import("./privy-island"); // code-split chunk
    mountPrivy(appId, (s) => {
      snap = s;
      if (s.ready && s.authenticated) resolveReady();
    });
  })();

  return {
    ready: () => readyP, // blocks boot until logged in (login required at boot)
    userId: () => snap?.did ?? "privy", // display-only; the server derives identity from the Bearer token
    async authHeaders(): Promise<Record<string, string>> {
      const t = snap ? await snap.getAccessToken() : null; // refreshes per call
      if (!t) return {};
      const wallet = snap?.walletAddress;
      return wallet ? { authorization: `Bearer ${t}`, "x-privy-wallet": wallet } : { authorization: `Bearer ${t}` };
    },
    logout: () => snap?.logout() ?? Promise.resolve(),
  };
}
