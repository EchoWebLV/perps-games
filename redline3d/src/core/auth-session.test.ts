import { describe, expect, it, vi } from "vitest";
import { createSessionAuth } from "./auth-session";

describe("createSessionAuth", () => {
  it("creates an anonymous session when no token is stored", async () => {
    const store = new Map<string, string>();
    const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ token: "tok", userId: "u1" }), { status: 200 }));
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: fetch as any,
      storage,
    });

    await auth.ready();

    expect(await auth.authHeaders()).toEqual({ authorization: "Bearer tok" });
    expect(auth.userId()).toBe("u1");
    expect(fetch).toHaveBeenCalledWith("http://api/v1/session", { method: "POST" });
  });

  it("reuses a stored session without calling fetch", async () => {
    const fetch = vi.fn();
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: fetch as any,
      storage: {
        getItem: (k: string) => (k.endsWith(":token") ? "stored-token" : "stored-user"),
        setItem: () => {},
        removeItem: () => {},
      } as any,
    });

    await auth.ready();

    expect(await auth.authHeaders()).toEqual({ authorization: "Bearer stored-token" });
    expect(auth.userId()).toBe("stored-user");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears stored session state on logout", async () => {
    const store = new Map<string, string>([
      ["redline.session:token", "stored-token"],
      ["redline.session:user", "stored-user"],
    ]);
    const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
    };
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: vi.fn() as any,
      storage,
    });

    await auth.ready();
    await auth.logout?.();

    expect(auth.userId()).toBe("");
    expect(store.get("redline.session:token")).toBeUndefined();
    expect(store.get("redline.session:user")).toBeUndefined();
  });

  it("retries session creation after a transient failure", async () => {
    const store = new Map<string, string>();
    const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
      removeItem: (k) => {
        store.delete(k);
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok", userId: "u1" }), { status: 200 }));
    const auth = createSessionAuth({
      baseUrl: "http://api",
      fetch: fetch as any,
      storage,
    });

    await expect(auth.ready()).rejects.toThrow("session_create_failed");
    await expect(auth.ready()).resolves.toBeUndefined();

    expect(await auth.authHeaders()).toEqual({ authorization: "Bearer tok" });
    expect(auth.userId()).toBe("u1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
