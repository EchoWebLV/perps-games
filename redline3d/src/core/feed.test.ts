// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { authorizeHermes, resolveHermesToken } from "./feed";

describe("resolveHermesToken", () => {
  it("prefers ?hermes= and remembers it", () => {
    const store = new Map<string, string>();
    const token = resolveHermesToken({
      search: "?hermes=pyth-key-1",
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    });
    expect(token).toBe("pyth-key-1");
    expect(store.get("hermes_token")).toBe("pyth-key-1");
  });

  it("accepts ?pyth= as an alias", () => {
    expect(resolveHermesToken({ search: "?pyth=alias-key" })).toBe("alias-key");
  });

  it("falls back to storage then env", () => {
    expect(resolveHermesToken({
      storage: { getItem: () => "stored-key", setItem: () => {} },
      envToken: "env-key",
    })).toBe("stored-key");
    expect(resolveHermesToken({ envToken: "env-key" })).toBe("env-key");
    expect(resolveHermesToken({})).toBe("");
  });
});

describe("authorizeHermes", () => {
  it("leaves the URL alone when no token is set", () => {
    expect(authorizeHermes("https://hermes.pyth.network/v2/updates/price/latest", "")).toEqual({
      url: "https://hermes.pyth.network/v2/updates/price/latest",
      headers: {},
    });
  });

  it("adds Bearer + ACCESS_TOKEN so EventSource and fetch both authenticate", () => {
    const req = authorizeHermes("https://hermes.pyth.network/v2/updates/price/latest?ids[]=abc", "secret");
    expect(req.headers.Authorization).toBe("Bearer secret");
    expect(req.url).toBe("https://hermes.pyth.network/v2/updates/price/latest?ids[]=abc&ACCESS_TOKEN=secret");
  });
});
