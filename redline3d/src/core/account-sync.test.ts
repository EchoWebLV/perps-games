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
    const sync = createAccountSync({ api, nonce: "t", applyServer: () => {} });
    const outcome = await sync.hydrate({ coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } });
    expect(outcome).toBe("seeded");
    expect(api.migrate).toHaveBeenCalledWith({ coins: 250, scrap: 30, cars: { orion: 1, clowncar: 2 } });
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
});
