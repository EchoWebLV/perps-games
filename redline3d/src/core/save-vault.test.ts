import { describe, expect, test } from "vitest";
import {
  GUEST_SAVE_NAMESPACE,
  IDENTITY_KEYS,
  stashSave,
  restoreSave,
  wipeSave,
  type VaultStore,
} from "./save-vault";

const memStore = (): VaultStore & { dump(): Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    dump: () => m,
  };
};

// keys that must NEVER move with an identity swap — device prefs + auth records
const DEVICE_KEYS: Record<string, string> = {
  "raider.howto.v1": "1",                 // how-to seen (device)
  "raider.access.magic.v1": "1",          // access-wall redemption (device entry gate)
  "raider.vol.music.v1": "0.6",           // audio prefs (device)
  "raider.identity": '{"name":"bob","mode":"privy"}', // auth record — the auth flows own it
};

const fillIdentityState = (store: VaultStore) => {
  const values: Record<string, string> = {};
  for (const [i, key] of IDENTITY_KEYS.entries()) {
    const v = `payload-${i}-${key}`;
    store.set(key, v);
    values[key] = v;
  }
  return values;
};

describe("IDENTITY_KEYS — the single source of truth for what swaps with identity", () => {
  test("uses a stable namespace for guest progress", () => {
    expect(GUEST_SAVE_NAMESPACE).toBe("guest");
  });

  test("classifies exactly the player-progress keys", () => {
    expect([...IDENTITY_KEYS].sort()).toEqual([
      "raider.raceSkin",    // selected world skin
      "raider.welcome.v1",  // welcome-gift claim (fresh guest re-earns it by design)
      "redline.garage.v1",  // coins / scrap / upgrade levels / finishes
      "redline.levels.v1",  // level-skin inventory
      "redline.owned.v1",   // counted car inventory
    ]);
  });
});

describe("stash → wipe → restore", () => {
  test("round-trips every identity key", () => {
    const store = memStore();
    const values = fillIdentityState(store);
    stashSave("WalletA", store);
    wipeSave(store);
    for (const key of IDENTITY_KEYS) expect(store.get(key)).toBeNull(); // wiped clean
    expect(restoreSave("WalletA", store)).toBe(true);
    for (const key of IDENTITY_KEYS) expect(store.get(key)).toBe(values[key]);
  });

  test("a key absent at stash time comes back absent (round-trips 'no value')", () => {
    const store = memStore();
    fillIdentityState(store);
    store.remove("raider.raceSkin"); // this player never picked a skin
    stashSave("WalletA", store);
    wipeSave(store);
    restoreSave("WalletA", store);
    expect(store.get("raider.raceSkin")).toBeNull();
    expect(store.get("redline.garage.v1")).not.toBeNull();
  });

  test("restore leaves the stash in place (a later logout-less reload can restore again)", () => {
    const store = memStore();
    fillIdentityState(store);
    stashSave("WalletA", store);
    wipeSave(store);
    restoreSave("WalletA", store);
    wipeSave(store);
    expect(restoreSave("WalletA", store)).toBe(true); // still there
    expect(store.get("redline.garage.v1")).toBe("payload-0-redline.garage.v1");
  });
});

describe("restoreSave with no stash", () => {
  test("returns false and leaves live keys absent", () => {
    const store = memStore();
    expect(restoreSave("NeverSeen", store)).toBe(false);
    for (const key of IDENTITY_KEYS) expect(store.get(key)).toBeNull();
  });

  test("does not cross namespaces — another account's stash is not a stash for this one", () => {
    const store = memStore();
    fillIdentityState(store);
    stashSave("WalletA", store);
    wipeSave(store);
    expect(restoreSave("WalletB", store)).toBe(false);
    for (const key of IDENTITY_KEYS) expect(store.get(key)).toBeNull();
  });
});

describe("wipeSave scope", () => {
  test("touches ONLY identity keys — device-global and auth keys survive", () => {
    const store = memStore();
    fillIdentityState(store);
    for (const [k, v] of Object.entries(DEVICE_KEYS)) store.set(k, v);
    wipeSave(store);
    for (const key of IDENTITY_KEYS) expect(store.get(key)).toBeNull();
    for (const [k, v] of Object.entries(DEVICE_KEYS)) expect(store.get(k)).toBe(v);
  });

  test("does not disturb stashed copies", () => {
    const store = memStore();
    fillIdentityState(store);
    stashSave("WalletA", store);
    wipeSave(store);
    expect(restoreSave("WalletA", store)).toBe(true);
  });
});

describe("stashing twice", () => {
  test("overwrites — a key deleted since the first stash leaves no stale copy", () => {
    const store = memStore();
    fillIdentityState(store);
    stashSave("WalletA", store);
    store.set("redline.garage.v1", "newer-coins");
    store.remove("raider.raceSkin"); // skin deselected since the first stash
    stashSave("WalletA", store);
    wipeSave(store);
    restoreSave("WalletA", store);
    expect(store.get("redline.garage.v1")).toBe("newer-coins"); // fresh copy won
    expect(store.get("raider.raceSkin")).toBeNull();            // stale copy did not resurrect
  });
});

describe("namespace isolation", () => {
  test("two accounts stash and restore independently", () => {
    const store = memStore();
    // account A's world
    store.set("redline.garage.v1", "A-garage");
    store.set("redline.owned.v1", "A-cars");
    stashSave("WalletA", store);
    wipeSave(store);
    // account B's world
    store.set("redline.garage.v1", "B-garage");
    store.set("redline.owned.v1", "B-cars");
    stashSave("WalletB", store);
    wipeSave(store);
    // back to A
    expect(restoreSave("WalletA", store)).toBe(true);
    expect(store.get("redline.garage.v1")).toBe("A-garage");
    // and B is intact for its own next login
    wipeSave(store);
    expect(restoreSave("WalletB", store)).toBe(true);
    expect(store.get("redline.owned.v1")).toBe("B-cars");
  });

  test("guest and account balances survive a login then logout round-trip", () => {
    const store = memStore();
    store.set("redline.garage.v1", '{"coins":17,"scrap":9}');
    stashSave(GUEST_SAVE_NAMESPACE, store);

    wipeSave(store);
    store.set("redline.garage.v1", '{"coins":120,"scrap":44}');
    stashSave("WalletA", store);

    wipeSave(store);
    expect(restoreSave(GUEST_SAVE_NAMESPACE, store)).toBe(true);
    expect(store.get("redline.garage.v1")).toBe('{"coins":17,"scrap":9}');

    wipeSave(store);
    expect(restoreSave("WalletA", store)).toBe(true);
    expect(store.get("redline.garage.v1")).toBe('{"coins":120,"scrap":44}');
  });
});
