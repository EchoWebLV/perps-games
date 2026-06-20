import { describe, it, expect } from "vitest";
import { getDevUserId, type KvStore } from "./identity";

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
