// First-login welcome gift: a one-time free Wooden crate for a brand-new player. The claim is a
// durable localStorage flag (decoupled from identity, so log-out / switch-driver never re-grants);
// the decision is a pure predicate so it's unit-tested without a browser.

import { browserStore, type KvStore } from "./identity";

const KEY = "raider.welcome.v1";

/** true once the first-login gift has been handed out (persists across logout / switch driver). */
export function welcomeClaimed(store: KvStore = browserStore): boolean {
  return store.get(KEY) === "1";
}

/** mark the first-login gift as handed out — also used to grandfather an existing player (no gift). */
export function markWelcome(store: KvStore = browserStore): void {
  store.set(KEY, "1");
}

/** grant the welcome crate only to a brand-new visitor who hasn't already claimed it. */
export function shouldGrantWelcome(freshVisitor: boolean, claimed: boolean): boolean {
  return freshVisitor && !claimed;
}
