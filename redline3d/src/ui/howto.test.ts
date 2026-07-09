// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { howToSeen, markHowToSeen } from "./howto";
import type { KvStore } from "../core/identity";

const memStore = (): KvStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

describe("how-to seen flag — durable once-ever", () => {
  test("starts unseen, stays seen after marking", () => {
    const store = memStore();
    expect(howToSeen(store)).toBe(false);
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });
  test("the seen mark persists across a fresh reader of the same store", () => {
    const store = memStore();
    markHowToSeen(store);
    expect(howToSeen(store)).toBe(true);
  });
});
