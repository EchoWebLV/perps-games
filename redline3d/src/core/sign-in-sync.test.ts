import { describe, it, expect, vi } from "vitest";
import { bindAndHydrate } from "./sign-in-sync";

describe("bindAndHydrate", () => {
  it("binds the wallet, adopts the session, then hydrates", async () => {
    const adoptSession = vi.fn();
    const hydrate = vi.fn(async () => "seeded" as const);
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "c", message: "sign me", wallet, expiresAt: "t" })),
      bindWallet: vi.fn(async () => ({ wallet: "Addr", token: "tok", userId: "uid" })),
    };
    const port = {
      connect: vi.fn(async () => ({ address: "Addr" })),
      signMessage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    };

    const outcome = await bindAndHydrate({
      api, auth: { adoptSession },
      port,
      accountSync: { hydrate } as any,
      localSnapshot: { coins: 10, scrap: 2, cars: { orion: 1 } },
    });

    expect(api.bindWalletChallenge).toHaveBeenCalledWith("Addr");
    expect(adoptSession).toHaveBeenCalledWith({ token: "tok", userId: "uid" });
    expect(hydrate).toHaveBeenCalledWith({ coins: 10, scrap: 2, cars: { orion: 1 } });
    expect(outcome).toBe("seeded");
  });

  it("still hydrates when the bind returns no session token (dev/back-compat)", async () => {
    const adoptSession = vi.fn();
    const hydrate = vi.fn(async () => "server" as const);
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "c", message: "m", wallet, expiresAt: "t" })),
      bindWallet: vi.fn(async () => ({ wallet: "Addr" })), // no token/userId
    };
    const port = { connect: vi.fn(async () => ({ address: "Addr" })), signMessage: vi.fn(async () => new Uint8Array([1])) };

    const outcome = await bindAndHydrate({
      api, auth: { adoptSession }, port, accountSync: { hydrate } as any,
      localSnapshot: { coins: 0, scrap: 0, cars: {} },
    });
    expect(adoptSession).not.toHaveBeenCalled();
    expect(outcome).toBe("server");
  });

  it("does not complete a fresh sign-in when the account cannot be hydrated", async () => {
    const api = {
      bindWalletChallenge: vi.fn(async (wallet: string) => ({ challenge: "c", message: "m", wallet, expiresAt: "t" })),
      bindWallet: vi.fn(async () => ({ wallet: "Addr", token: "tok", userId: "uid" })),
    };
    const port = {
      connect: vi.fn(async () => ({ address: "Addr" })),
      signMessage: vi.fn(async () => new Uint8Array([1])),
    };

    await expect(bindAndHydrate({
      api,
      auth: { adoptSession: vi.fn() },
      port,
      accountSync: { hydrate: vi.fn(async () => "offline" as const) } as any,
      localSnapshot: { coins: 0, scrap: 0, cars: {} },
      requireServerHydration: true,
    })).rejects.toThrow("account_hydration_failed");
  });
});
