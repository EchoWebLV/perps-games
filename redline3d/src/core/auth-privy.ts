import type { AuthProvider } from "./auth";
import type { PrivySnapshot } from "./privy-island";

/** Privy-backed AuthProvider. Lazy-imports the React island so the default build ships no React. */
export function createPrivyAuth(appId: string): AuthProvider {
  let snap: PrivySnapshot | null = null;
  let pendingLogin = false; // a login() pressed before the island mounts → fire it once Privy is ready
  let resolveReady!: () => void;
  const readyP = new Promise<void>((r) => (resolveReady = r));

  void (async () => {
    const { mountPrivy } = await import("./privy-island"); // code-split chunk
    mountPrivy(appId, (s) => {
      snap = s;
      if (s.ready && pendingLogin && !s.authenticated) { pendingLogin = false; s.login(); } // honor an early GO press
      if (s.ready && s.authenticated) resolveReady();
    });
  })();

  return {
    ready: () => readyP, // blocks boot until logged in (login required at boot)
    userId: () => snap?.did ?? "privy", // display-only; the server derives identity from the Bearer token
    async authHeaders(): Promise<Record<string, string>> {
      const t = snap ? await snap.getAccessToken() : null; // refreshes per call
      return t ? { authorization: `Bearer ${t}` } : {};
    },
    login: () => { if (snap?.ready) snap.login(); else pendingLogin = true; }, // queue if the island isn't up yet
    logout: () => snap?.logout() ?? Promise.resolve(),
    walletPublicKey: () => snap?.walletAddress ?? null,
    async signAndSend(txBase64: string): Promise<string> {
      if (!snap) throw new Error("no wallet");
      return snap.signAndSend(txBase64); // uses the latest snapshot's live Privy hooks
    },
  };
}
