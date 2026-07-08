import { describe, expect, test } from "vitest";
import { shouldGrantWelcome, welcomeClaimed, markWelcome } from "./welcome";
import type { KvStore } from "./identity";

const memStore = (): KvStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

describe("shouldGrantWelcome — first-login gift gate", () => {
  test("only a brand-new visitor who hasn't claimed gets the gift", () => {
    expect(shouldGrantWelcome(true, false)).toBe(true);   // fresh + unclaimed → gift
    expect(shouldGrantWelcome(true, true)).toBe(false);   // already claimed → no
    expect(shouldGrantWelcome(false, false)).toBe(false); // returning player → no
    expect(shouldGrantWelcome(false, true)).toBe(false);  // returning + claimed → no
  });
});

describe("welcome flag — durable once-ever claim", () => {
  test("starts unclaimed, and stays claimed after marking", () => {
    const store = memStore();
    expect(welcomeClaimed(store)).toBe(false);
    markWelcome(store);
    expect(welcomeClaimed(store)).toBe(true);
  });

  test("the claim persists across a fresh reader of the same store (survives reload)", () => {
    const store = memStore();
    markWelcome(store);
    expect(welcomeClaimed(store)).toBe(true); // a new call re-reads the store, not in-memory state
  });
});
