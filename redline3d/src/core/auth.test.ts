import { describe, it, expect } from "vitest";
import { createDevAuth } from "./auth-dev";

describe("dev auth provider", () => {
  it("sends x-dev-user and a stable id", async () => {
    const mem = new Map<string, string>();
    const a = createDevAuth({ get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) });
    await a.ready();
    const h = await a.authHeaders();
    expect(h["x-dev-user"]).toBe(a.userId());
    expect(a.userId()).toMatch(/^web-/);
  });
});
