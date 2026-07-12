import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { accountSignInTransition, getDevUserId, type KvStore } from "./identity";

function fakeStore(): KvStore & { map: Map<string, string>; sets: number } {
  const map = new Map<string, string>();
  return { map, sets: 0,
    get: (k) => map.get(k) ?? null,
    set(k, v) { this.sets++; map.set(k, v); } };
}

describe("getDevUserId", () => {
  it("generates a web-<id> once and reuses it", () => {
    const s = fakeStore();
    const a = getDevUserId(s);
    const b = getDevUserId(s);
    expect(a).toMatch(/^web-/);
    expect(b).toBe(a);
    expect(s.sets).toBe(1); // persisted exactly once
  });
});

describe("first account sign-in transition", () => {
  it("zeros fresh local state without reloading an already-warmed scene", () => {
    expect(accountSignInTransition(null)).toEqual({ zeroLocalSnapshot: true, reloadForSaveSwap: false });
    expect(accountSignInTransition({ mode: "guest" })).toEqual({ zeroLocalSnapshot: true, reloadForSaveSwap: true });
    expect(accountSignInTransition({ mode: "privy" })).toEqual({ zeroLocalSnapshot: false, reloadForSaveSwap: false });
  });

  it("uses the transition policy at the identity gate reload boundary", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf("async onSignIn(name)");
    const end = main.indexOf("return ok;", start);
    const signIn = main.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(signIn).toContain("accountSignInTransition(identity)");
    expect(signIn).toContain("if (transition.reloadForSaveSwap)");
    expect(signIn).not.toContain("const wasGuest = !identity");
  });
});

describe("driver name application wiring", () => {
  it("hydrates Railway names, exposes Settings editing, and guards Highway entry", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");

    expect(main).toContain('import { createDriverNameDialog } from "./ui/driver-name";');
    expect(main).toContain('import { highwayEntryDecision } from "./core/highway-access";');
    expect(main).toContain("const serverDriverName = accountSync.driverName();");
    expect(main).toContain("api.setDriverName(name)");
    expect(main).toContain("driverName: {");
    expect(main).toContain("current: () => identity?.name ?? null");
    expect(main).toContain("edit: () => openDriverNameDialog(false)");
    expect(main).toContain("const decision = highwayEntryDecision(");
    expect(main).toContain("globalThis.location?.hostname ?? \"\",");
    expect(main).toContain("driverNameConfirmed(),");
    expect(main).toContain("capacitorNative,");
    expect(main).toContain("openDriverNameDialog(true, enterHighwayFromLobby)");
  });

  it("clears the previous account name before switching accounts", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    const start = main.indexOf("async function ensureSignedIn");
    const end = main.indexOf("async function syncAccount", start);
    const signIn = main.slice(start, end);

    expect(signIn).toContain("accountDriverName = null;");
    expect(signIn).toContain("accountSync.disable();");
  });
});
