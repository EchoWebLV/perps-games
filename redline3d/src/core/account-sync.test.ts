import { describe, it, expect, vi } from "vitest";
import { createAccountSync, type AccountSnapshot } from "./account-sync";
import type { Api } from "./api";

function fakeApi(over: Partial<Api> = {}): Api {
  const base: Partial<Api> = {
    me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null, access: [] })),
    coinsEarn: vi.fn(async () => ({ coins: 0 })),
    coinsSpend: vi.fn(async () => ({ coins: 0 })),
    scrapEarn: vi.fn(async () => ({ scrap: 0 })),
    scrapSpend: vi.fn(async () => ({ scrap: 0 })),
    inventoryGrant: vi.fn(async () => ({ carId: "x", isNew: true, count: 1 })),
    inventoryMelt: vi.fn(async () => ({ carId: "x", melted: true, count: 1 })),
    migrate: vi.fn(async () => ({ seeded: true })),
    upgradesBuy: vi.fn(async () => ({ track: "turbo", level: 1, coins: 0 })),
  };
  return { ...base, ...over } as Api;
}
const empty: AccountSnapshot = { coins: 0, scrap: 0, cars: {} };

describe("createAccountSync", () => {
  it("forwarders no-op until hydrated, then post idempotent deltas", async () => {
    const api = fakeApi();
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });

    sync.coinsEarned(10); // disabled → ignored
    expect(api.coinsEarn).not.toHaveBeenCalled();

    await sync.hydrate(empty); // server empty + local empty → server-wins, enabled
    expect(sync.enabled()).toBe(true);

    sync.coinsEarned(10);
    sync.coinsEarned(5);
    await Promise.resolve();
    expect(api.coinsEarn).toHaveBeenNthCalledWith(1, { amount: 10, ref: "t:coinsEarn:0" });
    expect(api.coinsEarn).toHaveBeenNthCalledWith(2, { amount: 5, ref: "t:coinsEarn:1" });
  });

  it("seeds the server from local when the account is empty", async () => {
    const api = fakeApi();
    const applyServer = vi.fn();
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    const local = { coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } };
    const outcome = await sync.hydrate(local);
    expect(outcome).toBe("seeded");
    expect(api.migrate).toHaveBeenCalledWith(local);
    expect(applyServer).toHaveBeenCalledWith(local);
  });

  it("overwrites the local cache from server truth when the account is non-empty", async () => {
    const applyServer = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 500, scrap: 12, cars: [{ carId: "orion", count: 3, acquiredAt: "t" }], openRoundId: null, access: [] })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    const outcome = await sync.hydrate({ coins: 250, scrap: 30, cars: { skull: 1 } });
    expect(outcome).toBe("server");
    expect(api.migrate).not.toHaveBeenCalled(); // never sum local + server
    expect(applyServer).toHaveBeenCalledWith({ coins: 500, scrap: 12, cars: { orion: 3 } });
  });

  it("guest (api null) stays offline and never posts", async () => {
    const sync = createAccountSync({ api: null, nonce: "t", applyServer: () => {} });
    expect(await sync.hydrate({ coins: 99, scrap: 9, cars: {} })).toBe("offline");
    expect(sync.enabled()).toBe(false);
    sync.coinsEarned(10); // no throw, no-op
  });

  it("a failed /v1/me leaves it disabled (offline), game plays on cache", async () => {
    const api = fakeApi({ me: vi.fn(async () => { throw new Error("network"); }) });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    expect(await sync.hydrate(empty)).toBe("offline");
    expect(sync.enabled()).toBe(false);
  });

  it("swallows best-effort write failures without throwing", async () => {
    const api = fakeApi({ coinsEarn: vi.fn(async () => { throw new Error("boom"); }) });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    await sync.hydrate(empty);
    expect(() => sync.coinsEarned(10)).not.toThrow();
    await Promise.resolve();
  });

  it("passes server upgrade levels through to applyServer (server wins)", async () => {
    const applyServer = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({
        userId: "u", balance: 0, coins: 500, scrap: 12, cars: [{ carId: "orion", count: 1 }],
        openRoundId: null, access: [], levels: { turbo: 3, tank: 1, suspension: 2 },
      })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    expect(await sync.hydrate({ coins: 250, scrap: 30, cars: {}, levels: { turbo: 9, tank: 9, suspension: 9 } })).toBe("server");
    expect(applyServer).toHaveBeenCalledWith({
      coins: 500, scrap: 12, cars: { orion: 1 }, levels: { turbo: 3, tank: 1, suspension: 2 },
    });
  });

  it("an old server without levels → applyServer gets levels: undefined (locals preserved)", async () => {
    // A deployed server predating /v1/upgrades returns me WITHOUT levels. Server-wins must NOT
    // read that as all-zero and wipe the player's local upgrade levels.
    const applyServer = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 500, scrap: 0, cars: [], openRoundId: null, access: [] })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    expect(await sync.hydrate({ coins: 0, scrap: 0, cars: {}, levels: { turbo: 4, tank: 0, suspension: 0 } })).toBe("server");
    expect(applyServer).toHaveBeenCalledTimes(1);
    expect(applyServer.mock.calls[0][0].levels).toBeUndefined();
  });

  it("seeds when the server is empty and local has ONLY upgrade levels", async () => {
    // A local save with 0 coins / 0 scrap / no cars but bought levels still deserves migration.
    const api = fakeApi();
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    const local: AccountSnapshot = { coins: 0, scrap: 0, cars: {}, levels: { turbo: 2, tank: 0, suspension: 1 } };
    expect(await sync.hydrate(local)).toBe("seeded");
    expect(api.migrate).toHaveBeenCalledWith({ coins: 0, scrap: 0, cars: {}, levels: { turbo: 2, tank: 0, suspension: 1 } });
  });

  it("a server with non-zero levels is NOT empty — no migrate, server wins", async () => {
    // Mirrors the server's /v1/migrate emptiness semantics: any non-zero level blocks seeding.
    const applyServer = vi.fn();
    const api = fakeApi({
      me: vi.fn(async () => ({
        userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null, access: [],
        levels: { turbo: 1, tank: 0, suspension: 0 },
      })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer });
    expect(await sync.hydrate({ coins: 50, scrap: 0, cars: {} })).toBe("server");
    expect(api.migrate).not.toHaveBeenCalled();
    expect(applyServer).toHaveBeenCalledWith({ coins: 0, scrap: 0, cars: {}, levels: { turbo: 1, tank: 0, suspension: 0 } });
  });

  it("levelBought forwards the authoritative buy when enabled, no-ops when disabled", async () => {
    const api = fakeApi();
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });

    sync.levelBought("turbo"); // disabled → ignored
    expect(api.upgradesBuy).not.toHaveBeenCalled();

    await sync.hydrate(empty);
    sync.levelBought("turbo");
    await Promise.resolve();
    expect(api.upgradesBuy).toHaveBeenCalledWith({ track: "turbo" });
  });

  it("surfaces the account's redeemed access codes from hydrate (empty before, empty for guests)", async () => {
    // access is captured even on the all-zero 'server' path — a 'perpz' account has access but 0 coins.
    const api = fakeApi({
      me: vi.fn(async () => ({ userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null, access: ["magic"] })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    expect(sync.accessCodes()).toEqual([]);          // empty before hydrate
    await sync.hydrate(empty);
    expect(sync.accessCodes()).toEqual(["magic"]);   // reflects me().access after hydrate

    const guest = createAccountSync({ api: null, nonce: "t", applyServer: () => {} });
    await guest.hydrate(empty);
    expect(guest.accessCodes()).toEqual([]);         // guests never hydrate → stays empty
  });

  it("surfaces the Railway driver name after hydrate and clears it on disable", async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({
        userId: "u", balance: 0, coins: 0, scrap: 0, cars: [], openRoundId: null,
        access: [], driverName: "road_king",
      })),
    });
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });

    expect(sync.driverName()).toBeNull();
    await sync.hydrate(empty);
    expect(sync.driverName()).toBe("road_king");
    sync.disable();
    expect(sync.driverName()).toBeNull();
  });
});
