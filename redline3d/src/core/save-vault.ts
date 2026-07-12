// Identity-scoped saves — the swap that makes "guest" and "account" feel like different players.
// The live game-state keys stay the plain names every consumer already reads/writes; this module
// only STASHES them into a per-identity namespace at transitions, WIPES them, and RESTORES them at
// sign-in (then the caller reloads, so the app boots into the restored world).
//
// IDENTITY_KEYS is the single source of truth for what is player progress. Everything else is
// deliberately out of scope:
//   device-global (never touched): raider.howto.v1, raider.access.*.v1 (entry gates), raider.vol.*,
//     raider.bgOpacity, lazer_token — device prefs, not progress.
//   auth/session (owned by the auth flows): raider.identity, redline.session:*, redline.chain.devkey.v1,
//     redline.devuser.v1, redline.round.v1 (round crash-recovery), privy:* (Privy SDK),
//     redline.trade-history.outbox.v1:* (server-sync queue with its own flush lifecycle).
//
// Pure functions over an injectable store (the welcome.ts/audio-prefs.ts idiom, plus `remove` —
// a stash/wipe can't exist without deletion).

import { type KvStore } from "./identity";

export interface VaultStore extends KvStore {
  remove(key: string): void;
}

/** Stable local namespace for the guest rider. Account namespaces use their wallet address. */
export const GUEST_SAVE_NAMESPACE = "guest";

/** localStorage-backed store, safe in non-DOM/blocked contexts */
export const browserVaultStore: VaultStore = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Player progress — the keys that swap with identity. Everything else stays put. */
export const IDENTITY_KEYS: readonly string[] = [
  "redline.garage.v1",  // coins / scrap / upgrade levels / finishes (ui/upgrades.ts)
  "redline.owned.v1",   // counted car inventory (core/inventory.ts via main.ts)
  "redline.levels.v1",  // level-skin inventory (core/inventory.ts via main.ts)
  "raider.welcome.v1",  // welcome-gift claim — a fresh guest re-earns the gift by design (core/welcome.ts)
  "raider.raceSkin",    // selected world skin (render/world-themes.ts)
];

const vaultKey = (ns: string, key: string) => `vault:${ns}:${key}`;

/** Copy the live identity keys into `ns`'s stash. A live key that no longer exists clears its
 *  stashed copy too — stashing twice never leaves stale leftovers. */
export function stashSave(ns: string, store: VaultStore = browserVaultStore): void {
  for (const key of IDENTITY_KEYS) {
    const v = store.get(key);
    if (v === null) store.remove(vaultKey(ns, key));
    else store.set(vaultKey(ns, key), v);
  }
}

/** Copy `ns`'s stashed keys back onto the live names (the stash stays in place). Returns true if
 *  a stash existed. Purely additive — call wipeSave() first; a key absent from the stash is left
 *  absent live. */
export function restoreSave(ns: string, store: VaultStore = browserVaultStore): boolean {
  let found = false;
  for (const key of IDENTITY_KEYS) {
    const v = store.get(vaultKey(ns, key));
    if (v === null) continue;
    store.set(key, v);
    found = true;
  }
  return found;
}

/** Remove the live identity keys — and nothing else (device prefs, auth records, stashes survive). */
export function wipeSave(store: VaultStore = browserVaultStore): void {
  for (const key of IDENTITY_KEYS) store.remove(key);
}
