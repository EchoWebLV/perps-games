// Access codes — an optional pre-login unlock for judges and the owner. Entering a valid code on the
// identity gate unlocks its reward exactly once, then is remembered forever (a durable localStorage
// flag, one per code, mirroring the `raider.welcome.v1` once-ever precedent). The redeem is a pure
// function with every side effect injected as a port, so the whole contract is unit-tested headless.
//
// SCOPE IS EXACT:
//   "magic" → every car owned + 1,000 coins. Nothing else (no scrap, no skins).
//   "perpz" → entry only. Unlocks the wall and nothing more — regular gameplay from a clean slate.

import { browserStore, type KvStore } from "./identity";
import type { Api } from "./api";

export interface AccessReward {
  /** unlock every car in the roster — already-owned copies are skipped (the inventory is COUNTED). */
  allCars: boolean;
  /** coins credited once, on the first redemption of this code. */
  coins: number;
}

/**
 * The code table — the single source of truth for what each code grants.
 * KEYS MUST BE LOWERCASE (lookups normalize the typed code to lowercase for case-insensitive match).
 * Add a new code = add one line, e.g.  `press: { allCars: true, coins: 500 },`
 */
export const ACCESS_CODES: Record<string, AccessReward> = {
  magic: { allCars: true, coins: 1000 },
  perpz: { allCars: false, coins: 0 },
};

export interface RedeemPorts {
  /** every car id in the roster (car `name`s) — all become owned when a reward sets `allCars`. */
  rosterIds: string[];
  /** is this car already owned? Owned cars are skipped so a re-grant never stacks a duplicate copy. */
  owns(id: string): boolean;
  /** grant ONE new car: bank it in the counted inventory AND unlock its garage card. */
  grantCar(id: string): void;
  /** credit coins through the SAME seam earned coins use (HUD refresh + signed-in ledger sync). */
  credit(n: number): void;
  /** durable redemption flags; defaults to localStorage. One flag per code id. */
  store?: KvStore;
}

export type RedeemResult = "granted" | "already" | "invalid";

/** compare codes the way redemption does: trimmed + lowercased. */
export function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase();
}

const flagKey = (codeId: string) => `raider.access.${codeId}.v1`;
const accountFlagKey = (accountId: string, codeId: string) => `raider.access.account.${accountId}.${codeId}.v1`;

/** true once this code has been redeemed on this browser (persists across reloads / logout / switch). */
export function isRedeemed(codeId: string, store: KvStore = browserStore): boolean {
  return store.get(flagKey(codeId)) === "1";
}

/** true once ANY access code has been redeemed here — drives the gate's persistent "unlocked" state. */
export function anyRedeemed(store: KvStore = browserStore): boolean {
  return Object.keys(ACCESS_CODES).some((id) => isRedeemed(id, store));
}

/** Browser fallback state scoped to one signed-in wallet, never shared with guests or other accounts. */
export function isAccountRedeemed(accountId: string, codeId: string, store: KvStore = browserStore): boolean {
  return store.get(accountFlagKey(accountId, codeId)) === "1";
}

/** True when this exact signed-in account redeemed any access code on this browser. */
export function anyAccountRedeemed(accountId: string, store: KvStore = browserStore): boolean {
  return Object.keys(ACCESS_CODES).some((id) => isAccountRedeemed(accountId, id, store));
}

/**
 * Redeem an access code. Pure, idempotent, and persistent:
 *  - unknown code            → "invalid" (no effect at all)
 *  - valid but already used  → "already" (no re-grant: no duplicate cars, no extra coins)
 *  - first valid redemption  → grant unowned cars + credit coins once, set the durable flag → "granted"
 *
 * The flag is written LAST, so a mid-redeem failure leaves it unset and the player can retry.
 */
export function redeem(raw: string, ports: RedeemPorts): RedeemResult {
  const store = ports.store ?? browserStore;
  const codeId = normalizeCode(raw);
  const reward = ACCESS_CODES[codeId];
  if (!reward) return "invalid";
  if (isRedeemed(codeId, store)) return "already";
  if (reward.allCars) {
    for (const id of ports.rosterIds) if (!ports.owns(id)) ports.grantCar(id);
  }
  if (reward.coins > 0) ports.credit(reward.coins);
  store.set(flagKey(codeId), "1");
  return "granted";
}

/**
 * Account redemption is the signed-in counterpart to redeem(). It uses the server as authority and
 * keeps only an account-scoped browser fallback:
 * the server is the authority on which codes an account has claimed (idempotent per account+code),
 * but a server hiccup must NEVER wall the player out (that dead end was the whole bug). So:
 *  - unknown code                     → "invalid" (no server call at all)
 *  - already recorded for this account on this browser → "already" (no second local grant)
 *  - server reachable, first time     → grant unowned cars + credit coins once → "granted"
 *  - server reachable, already        → "already" (apply NOTHING — no duplicate cars, no extra coins)
 *  - server UNREACHABLE               → grant locally anyway → "granted"; the cars/coins still sync to
 *                                       the account via the earn-deltas, and the server `access_codes`
 *                                       record fills in on a later online redeem.
 * The local flag includes the wallet address, so one guest or account can never unlock another.
 */
export async function redeemForAccount(
  raw: string,
  ports: {
    api: Pick<Api, "redeemAccess">;
    accountId: string;
    rosterIds: string[];
    owns(id: string): boolean;
    grantCar(id: string): void;
    credit(n: number): void;
    /** Wait for reward writes before a caller is allowed to reload or leave the account. */
    flush?: () => Promise<void>;
    store?: KvStore;
  },
): Promise<RedeemResult> {
  const store = ports.store ?? browserStore;
  const codeId = normalizeCode(raw);
  const reward = ACCESS_CODES[codeId];
  if (!reward) return "invalid"; // don't burn a server round-trip on a typo
  if (isAccountRedeemed(ports.accountId, codeId, store)) return "already";
  const applyReward = () => {
    if (reward.allCars) {
      for (const id of ports.rosterIds) if (!ports.owns(id)) ports.grantCar(id);
    }
    if (reward.coins > 0) ports.credit(reward.coins);
  };
  let granted: boolean;
  try {
    ({ granted } = await ports.api.redeemAccess(codeId));
  } catch {
    // Server unreachable — never lock the player out. Best-effort local grant; the account record
    // reconciles on the next online redeem (owned cars are skipped, so no duplicate copies).
    applyReward();
    store.set(accountFlagKey(ports.accountId, codeId), "1");
    return "granted";
  }
  if (granted) {
    applyReward(); // server: first time for this account → grant once
    await ports.flush?.();
  }
  store.set(accountFlagKey(ports.accountId, codeId), "1");
  return granted ? "granted" : "already";
}
