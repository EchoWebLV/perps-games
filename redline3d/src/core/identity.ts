export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** localStorage-backed store, safe in non-DOM/blocked contexts */
export const browserStore: KvStore = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const KEY = "redline.devuser.v1";

/** stable per-browser dev identity sent as `x-dev-user` (Privy replaces this in 1.3) */
export function getDevUserId(store: KvStore = browserStore): string {
  let id = store.get(KEY);
  if (!id) {
    id = "web-" + crypto.randomUUID();
    store.set(KEY, id);
  }
  return id;
}
