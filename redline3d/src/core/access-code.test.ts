import { describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { redeem, redeemForAccount, normalizeCode, isRedeemed, isAccountRedeemed, anyRedeemed, ACCESS_CODES, type RedeemPorts } from "./access-code";
import { createInventory } from "./inventory";
import type { KvStore } from "./identity";

const memStore = (): KvStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

// a tiny in-memory Storage so the REAL counted inventory can back the ports (never touches localStorage)
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
};

// stand-in roster; "Solana Paper" is free (pre-owned at count 1), exactly like the real inventory
const ROSTER = ["Solana Paper", "Orion", "DeLorean", "Clown Car"];

// a harness whose owns/grantCar are backed by a REAL createInventory (counted) so the
// no-duplicate-copies guarantee is proven end-to-end, not just against a mock.
function harness() {
  const store = memStore();
  const inv = createInventory("redline.owned.v1", ["Solana Paper"], memStorage());
  const creditCalls: number[] = [];
  const ports: RedeemPorts = {
    rosterIds: ROSTER,
    owns: (id) => inv.owns(id),
    grantCar: (id) => { inv.grant(id); },
    credit: (n) => { creditCalls.push(n); },
    store,
  };
  return { store, inv, ports, creditCalls };
}

describe("ACCESS_CODES table — the exact reward contract", () => {
  test("'magic' unlocks all cars and grants exactly 1,000 coins", () => {
    expect(ACCESS_CODES.magic).toEqual({ allCars: true, coins: 1000 });
  });
  test("'perpz' is entry-only — no cars, no coins (regular gameplay)", () => {
    expect(ACCESS_CODES.perpz).toEqual({ allCars: false, coins: 0 });
  });
  test("table keys are lowercase (case-insensitive lookup relies on it)", () => {
    for (const k of Object.keys(ACCESS_CODES)) expect(k).toBe(k.toLowerCase());
  });
});

describe("normalizeCode — trim + lowercase", () => {
  test("strips surrounding whitespace and lowercases", () => {
    expect(normalizeCode("  MAGIC ")).toBe("magic");
    expect(normalizeCode("MaGiC")).toBe("magic");
    expect(normalizeCode("magic")).toBe("magic");
  });
});

describe("redeem — invalid codes have no effect", () => {
  test("unknown code returns 'invalid', grants nothing, credits nothing, sets no flag", () => {
    const h = harness();
    expect(redeem("nope", h.ports)).toBe("invalid");
    expect(redeem("", h.ports)).toBe("invalid");
    expect(h.inv.all().sort()).toEqual(["Solana Paper"]); // only the free car
    expect(h.creditCalls).toEqual([]);
    expect(isRedeemed("magic", h.store)).toBe(false);
    expect(anyRedeemed(h.store)).toBe(false);
  });
});

describe("redeem — a first valid redemption", () => {
  test("'magic' owns every roster car and credits 1,000 once", () => {
    const h = harness();
    expect(redeem("magic", h.ports)).toBe("granted");
    for (const id of ROSTER) expect(h.inv.owns(id)).toBe(true);
    expect(h.creditCalls).toEqual([1000]);
    expect(isRedeemed("magic", h.store)).toBe(true);
    expect(anyRedeemed(h.store)).toBe(true);
  });

  test("is case-insensitive and trims", () => {
    const h = harness();
    expect(redeem("  MaGiC  ", h.ports)).toBe("granted");
    expect(h.inv.owns("Orion")).toBe(true);
    expect(h.creditCalls).toEqual([1000]);
  });

  test("already-owned cars are SKIPPED — the counted inventory never stacks a duplicate", () => {
    const h = harness();
    h.inv.grant("Orion");            // pre-owned via an earlier crate pull → count 1
    expect(h.inv.count("Orion")).toBe(1);
    expect(redeem("magic", h.ports)).toBe("granted");
    expect(h.inv.count("Orion")).toBe(1);   // NOT 2 — skipped, no dup copy
    expect(h.inv.count("Solana Paper")).toBe(1); // free car also skipped, not re-granted
    expect(h.inv.count("DeLorean")).toBe(1); // freshly unlocked
  });

  test("grantCar is invoked only for cars the player does not already own", () => {
    const store = memStore();
    const owned = new Set(["Solana Paper", "Orion"]);
    const grantCar = vi.fn((id: string) => owned.add(id));
    redeem("magic", { rosterIds: ROSTER, owns: (id) => owned.has(id), grantCar, credit: () => {}, store });
    expect(grantCar).toHaveBeenCalledTimes(2);        // only DeLorean + Clown Car
    expect(grantCar).not.toHaveBeenCalledWith("Solana Paper");
    expect(grantCar).not.toHaveBeenCalledWith("Orion");
  });
});

describe("redeem — 'perpz' unlocks the wall but grants nothing (regular gameplay)", () => {
  test("returns 'granted', banks no car, credits nothing, yet sets its own durable flag", () => {
    const h = harness();
    expect(redeem("perpz", h.ports)).toBe("granted");
    expect(h.inv.all().sort()).toEqual(["Solana Paper"]); // only the free car — nothing was granted
    expect(h.creditCalls).toEqual([]);                // no coins credited
    expect(isRedeemed("perpz", h.store)).toBe(true);
    expect(h.store.get("raider.access.perpz.v1")).toBe("1"); // the exact persistent flag key
    expect(anyRedeemed(h.store)).toBe(true);          // and it satisfies the wall-skip
  });

  test("is case-insensitive, trims, and is idempotent (re-entry → 'already', still no grants)", () => {
    const h = harness();
    expect(redeem("  PeRpZ ", h.ports)).toBe("granted");
    expect(redeem("perpz", h.ports)).toBe("already");
    expect(h.inv.all().sort()).toEqual(["Solana Paper"]);
    expect(h.creditCalls).toEqual([]);
  });

  test("each code owns its own flag — redeeming 'perpz' never marks 'magic' redeemed", () => {
    const h = harness();
    redeem("perpz", h.ports);
    expect(isRedeemed("magic", h.store)).toBe(false);
  });
});

describe("redeem — idempotent + persistent (the anti-double-grant guarantees)", () => {
  test("re-entering the code returns 'already' and re-grants nothing", () => {
    const h = harness();
    expect(redeem("magic", h.ports)).toBe("granted");
    const ownedAfterFirst = h.inv.all().sort();
    expect(redeem("magic", h.ports)).toBe("already");
    expect(redeem("MAGIC", h.ports)).toBe("already"); // still already, case-insensitive
    expect(h.inv.all().sort()).toEqual(ownedAfterFirst); // no extra copies
    expect(h.creditCalls).toEqual([1000]);               // coins credited exactly once, ever
  });

  test("the flag persists across a fresh reader (survives reload)", () => {
    const h = harness();
    redeem("magic", h.ports);
    // a brand-new redeem call re-reads the same store — no in-memory carryover
    expect(isRedeemed("magic", h.store)).toBe(true);
    expect(redeem("magic", { ...h.ports })).toBe("already");
  });

  test("a mid-redeem failure leaves the flag unset so the player can retry", () => {
    const store = memStore();
    const boom = { rosterIds: ROSTER, owns: () => false, grantCar: () => { throw new Error("io"); }, credit: () => {}, store };
    expect(() => redeem("magic", boom)).toThrow();
    expect(isRedeemed("magic", store)).toBe(false); // not marked → a retry is allowed
  });
});

describe("redeemForAccount — the signed-in path (server-first, account-scoped fallback)", () => {
  // Wire the account ports onto the SAME counted inventory the guest path uses, so the reward
  // application is proven identical — only the once-guard (server vs browser flag) differs.
  const acctPorts = (h: ReturnType<typeof harness>, granted: boolean) => ({
    api: { redeemAccess: vi.fn(async (_code: string) => ({ granted })) },
    accountId: "acct-a",
    rosterIds: ROSTER,
    owns: (id: string) => h.inv.owns(id),
    grantCar: (id: string) => { h.inv.grant(id); },
    credit: (n: number) => { h.creditCalls.push(n); },
    store: h.store,
  });

  test("server grants 'magic' → applies the SAME reward (all cars + 1,000 coins) and returns 'granted'", async () => {
    const h = harness();
    const ports = acctPorts(h, true);
    expect(await redeemForAccount("  MaGiC ", ports)).toBe("granted");
    for (const id of ROSTER) expect(h.inv.owns(id)).toBe(true);
    expect(h.creditCalls).toEqual([1000]);
    expect(ports.api.redeemAccess).toHaveBeenCalledWith("magic"); // normalized code id sent to the server
    expect(isAccountRedeemed("acct-a", "magic", h.store)).toBe(true);
  });

  test("waits for the granted reward to persist before redemption completes", async () => {
    const h = harness();
    let finishFlush!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const ports = {
      ...h.ports,
      api: { redeemAccess: vi.fn(async () => ({ granted: true })) },
      accountId: "acct-a",
      flush,
    };

    let completed = false;
    const redemption = redeemForAccount("magic", ports).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);

    finishFlush();
    await expect(redemption).resolves.toBe("granted");
  });

  test("a browser flag left by another rider cannot bypass this account's server redemption", async () => {
    const h = harness();
    h.store.set("raider.access.magic.v1", "1");
    const ports = acctPorts(h, true);

    expect(await redeemForAccount("magic", ports)).toBe("granted");
    expect(ports.api.redeemAccess).toHaveBeenCalledWith("magic");
    expect(h.creditCalls).toEqual([1000]);
  });

  test("server says already-claimed → applies NOTHING and returns 'already' (no double coins)", async () => {
    const h = harness();
    const ports = acctPorts(h, false);
    expect(await redeemForAccount("magic", ports)).toBe("already");
    expect(h.inv.all().sort()).toEqual(["Solana Paper"]); // only the free car — nothing granted
    expect(h.creditCalls).toEqual([]);                // and no coins credited
    expect(ports.api.redeemAccess).toHaveBeenCalledTimes(1);
  });

  test("unknown code → 'invalid' and the server is NEVER called", async () => {
    const h = harness();
    const ports = acctPorts(h, true);
    expect(await redeemForAccount("nope", ports)).toBe("invalid");
    expect(ports.api.redeemAccess).not.toHaveBeenCalled();
    expect(h.creditCalls).toEqual([]);
  });

  test("records the code on this browser → a second attempt short-circuits to 'already' with NO server call", async () => {
    const h = harness();
    const ports = acctPorts(h, true);
    expect(await redeemForAccount("magic", ports)).toBe("granted");
    expect(isAccountRedeemed("acct-a", "magic", h.store)).toBe(true);
    expect(await redeemForAccount("magic", ports)).toBe("already"); // the local flag guards the re-grant
    expect(ports.api.redeemAccess).toHaveBeenCalledTimes(1);        // the 2nd attempt never hit the server
    expect(h.creditCalls).toEqual([1000]);                          // coins credited exactly once, ever
  });

  test("server UNREACHABLE → still unlocks locally so the player is never walled out", async () => {
    const h = harness();
    const ports = {
      api: { redeemAccess: vi.fn(async () => { throw new Error("network"); }) },
      accountId: "acct-a",
      rosterIds: ROSTER,
      owns: (id: string) => h.inv.owns(id),
      grantCar: (id: string) => { h.inv.grant(id); },
      credit: (n: number) => { h.creditCalls.push(n); },
      store: h.store,
    };
    expect(await redeemForAccount("magic", ports)).toBe("granted"); // fallback grant, not a dead end
    for (const id of ROSTER) expect(h.inv.owns(id)).toBe(true);     // reward applied locally
    expect(h.creditCalls).toEqual([1000]);
    expect(isAccountRedeemed("acct-a", "magic", h.store)).toBe(true);
  });
});

describe("signed-in access wall wiring", () => {
  test("a device-wide guest redemption cannot bypass a fresh signed-in account", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf("function accountAccessThenEnter");
    const end = main.indexOf("async function offerWelcomeAccount", start);
    const accountGate = main.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(accountGate).toContain("accountSync.accessCodes().length > 0");
    expect(accountGate).not.toContain("anyRedeemed()");
  });

  test("reloads after signed-in redemption without changing the guest continuation", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const guestStart = main.indexOf("function guestAccessThenEnter");
    const accountStart = main.indexOf("function accountAccessThenEnter", guestStart);
    const accountEnd = main.indexOf("async function offerWelcomeAccount", accountStart);
    const guestGate = main.slice(guestStart, accountStart);
    const accountGate = main.slice(accountStart, accountEnd);

    expect(accountGate).toContain("onUnlocked: () => location.reload()");
    expect(accountGate).not.toContain("onUnlocked: onDone");
    expect(guestGate).toContain("onUnlocked: onDone");
    expect(guestGate).not.toContain("location.reload()");
  });
});
