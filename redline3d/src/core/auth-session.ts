import type { AuthProvider } from "./auth";

export interface SessionAuthOpts {
  baseUrl?: string;
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const TOKEN_KEY = "redline.session:token";
const USER_KEY = "redline.session:user";

export function createSessionAuth(opts: SessionAuthOpts = {}): AuthProvider {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (opts.baseUrl ?? (import.meta.env.VITE_API_BASE as string) ?? "http://localhost:8080").replace(/\/$/, "");
  const storage = opts.storage ?? localStorage;
  let token = storage.getItem(TOKEN_KEY);
  let uid = storage.getItem(USER_KEY) ?? "";
  let init: Promise<void> | null = null;

  async function ensure() {
    if (token && uid) return;
    const res = await doFetch(`${baseUrl}/v1/session`, { method: "POST" });
    if (!res.ok) throw new Error("session_create_failed");
    const body = await res.json() as { token: string; userId: string };
    token = body.token;
    uid = body.userId;
    storage.setItem(TOKEN_KEY, token);
    storage.setItem(USER_KEY, uid);
  }

  function startInit() {
    if (!init) {
      init = ensure().catch((err) => {
        init = null;
        throw err;
      });
    }
    return init;
  }

  function clearSession(): void {
    storage.removeItem(TOKEN_KEY);
    storage.removeItem(USER_KEY);
    token = null;
    uid = "";
    init = null;
  }

  return {
    ready() {
      return startInit();
    },
    userId() {
      return uid;
    },
    async authHeaders() {
      await startInit();
      return { authorization: `Bearer ${token}` };
    },
    adoptSession(session) {
      token = session.token;
      uid = session.userId;
      init = Promise.resolve();
      storage.setItem(TOKEN_KEY, token);
      storage.setItem(USER_KEY, uid);
    },
    invalidateSession() {
      clearSession();
    },
    async logout() {
      clearSession();
    },
  };
}
