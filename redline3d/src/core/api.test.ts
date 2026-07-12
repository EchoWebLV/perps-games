import { describe, it, expect } from "vitest";
import { createApi, ApiError } from "./api";

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createApi", () => {
  it("sends x-dev-user + base url and parses openRound", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x:8080", userId: "web-test",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { roundId: "r1", asset: "SOL", dir: 1, lev: 50, stake: 5, entryRaw: 100, entryTsUs: 1 }); },
    });
    const out = await api.openRound({ asset: "SOL", dir: 1, lev: 50, stake: 5 });
    expect(out.roundId).toBe("r1");
    expect(seen!.url).toBe("http://x:8080/v1/round/open");
    expect((seen!.init.headers as Record<string,string>)["x-dev-user"]).toBe("web-test");
  });

  it("keeps account POST writes alive if the web page is closing", async () => {
    const calls: RequestInit[] = [];
    const api = createApi({
      baseUrl: "http://x", userId: "web-test",
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return res(200, calls.length === 1 ? { coins: 1 } : { userId: "u", balance: 0, cars: [], openRoundId: null });
      },
    });

    await api.coinsEarn({ amount: 1, ref: "e1" });
    await api.me();

    expect(calls[0].keepalive).toBe(true);
    expect(calls[1].keepalive).toBe(false);
  });

  it("uses the page hostname for the API when opened from a LAN dev URL", async () => {
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:", hostname: "192.168.1.102" },
    });
    try {
      let seenUrl = "";
      const api = createApi({
        userId: "web-test",
        fetch: async (url) => {
          seenUrl = String(url);
          return res(200, { userId: "u", balance: 100, cars: [], openRoundId: null });
        },
      });

      await api.me();

      expect(seenUrl).toBe("http://192.168.1.102:8080/v1/me");
    } finally {
      if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
      else delete (globalThis as any).location;
    }
  });

  it("maps status codes to typed ApiError codes", async () => {
    const mk = (status: number, body: unknown) =>
      createApi({ baseUrl: "http://x", userId: "u", fetch: async () => res(status, body) });
    await expect(mk(402, { error: "insufficient_balance" }).openRound({ asset: "SOL", dir: 1, lev: 50, stake: 5 }))
      .rejects.toMatchObject({ code: "insufficient_balance" });
    await expect(mk(409, { error: "round_already_open" }).openRound({ asset: "SOL", dir: 1, lev: 50, stake: 5 }))
      .rejects.toMatchObject({ code: "round_already_open" });
    await expect(mk(503, { error: "feed_halt" }).closeRound({ roundId: "r", reason: "cashout" }))
      .rejects.toMatchObject({ code: "feed_halt" });
  });

  it.each(["trade_id_conflict", "trade_wallet_mismatch"] as const)(
    "maps %s without misclassifying it as a round conflict",
    async (code) => {
      const api = createApi({
        baseUrl: "http://x",
        userId: "u",
        fetch: async () => res(409, { error: code }),
      });
      const record = {
        id: "11111111-1111-4111-8111-111111111111",
        asset: "SOL" as const,
        dir: 1 as const,
        lev: 250,
        stakeBase: 10_000_000,
        entryPrice: 150,
        exitPrice: 151,
        openedAt: "2026-07-10T10:00:00.000Z",
        outcome: "cashout" as const,
        payoutBase: 11_000_000,
      };

      await expect(api.recordTrade(record, "AliceWallet")).rejects.toMatchObject({
        code,
        status: 409,
        bodyError: code,
      });
    },
  );

  it("markRound GETs the mark endpoint and parses the mark", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x", userId: "u",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { status: "open", stale: false, outcome: "cashout", equity: 1.5, payoutCoins: 14, buffer: 0.9 }); },
    });
    const m = await api.markRound("R1");
    expect(seen!.url).toBe("http://x/v1/round/R1/mark");
    expect(seen!.init.method).toBe("GET");
    expect(m.equity).toBe(1.5);
    expect(m.payoutCoins).toBe(14);
  });

  it("maps a fetch throw to a network ApiError", async () => {
    const api = createApi({ baseUrl: "http://x", userId: "u", fetch: async () => { throw new Error("offline"); } });
    await expect(api.me()).rejects.toMatchObject({ code: "network" });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });

  it("attaches the auth provider's headers to every request", async () => {
    const calls: any[] = [];
    const fakeFetch = async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ balance: 1 }), { status: 200 }); };
    const auth = { ready: async () => {}, userId: () => "u", authHeaders: async () => ({ authorization: "Bearer XYZ" }) };
    const api = createApi({ fetch: fakeFetch as any, baseUrl: "http://x", auth });
    await api.me();
    expect(calls[0].init.headers.authorization).toBe("Bearer XYZ");
    expect(calls[0].init.headers["x-dev-user"]).toBeUndefined();
  });

  it("clears a stale bearer token and retries once when the server rejects the token", async () => {
    const calls: any[] = [];
    let token = "stale";
    const auth = {
      ready: async () => {},
      userId: () => "u",
      authHeaders: async () => ({ authorization: `Bearer ${token}` }),
      logout: async () => { token = "fresh"; },
    };
    const api = createApi({
      baseUrl: "http://x",
      auth,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const header = (init?.headers as Record<string, string>).authorization;
        if (header === "Bearer stale") return res(401, { error: "invalid_token" });
        return res(200, { userId: "u", balance: 100, cars: [], openRoundId: null });
      },
    });

    await expect(api.me()).resolves.toMatchObject({ balance: 100 });

    expect(calls.map((call) => call.init.headers.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("does not retry application-level 401 responses", async () => {
    let calls = 0;
    const auth = {
      ready: async () => {},
      userId: () => "u",
      authHeaders: async () => ({ authorization: "Bearer valid" }),
      logout: async () => { throw new Error("must_not_logout"); },
    };
    const api = createApi({
      baseUrl: "http://x",
      auth,
      fetch: async () => {
        calls++;
        return res(401, { error: "invalid_wallet_signature" });
      },
    });

    await expect(api.bindWallet({ challenge: "c", signatureBase58: "s" })).rejects.toMatchObject({
      code: "unauthorized",
      bodyError: "invalid_wallet_signature",
    });
    expect(calls).toBe(1);
  });

  it("aborts a hung request after the timeout and surfaces a network ApiError", async () => {
    // a fetch that never settles on its own — only the abort signal can end it (a stalled connection)
    const hangFetch = (_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const api = createApi({ baseUrl: "http://x", userId: "u", fetch: hangFetch as any, timeoutMs: 10 });
    await expect(api.me()).rejects.toMatchObject({ code: "network" });
  });

  it("calls wallet bind and deposit endpoints with the new payloads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const api = createApi({
      baseUrl: "http://x",
      userId: "u",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/v1/wallet/bind-challenge")) {
          return res(200, { challenge: "c1", message: "m1", wallet: "w1", expiresAt: "2026-01-01T00:00:00.000Z" });
        }
        if (String(url).endsWith("/v1/wallet/bind")) {
          return res(200, { wallet: "w1" });
        }
        if (String(url).endsWith("/v1/deposit/build")) {
          return res(200, { txBase64: "tx", depositIntent: "di_1", expiresAt: "2026-01-01T00:00:00.000Z" });
        }
        if (String(url).endsWith("/v1/deposit/send")) {
          return res(200, { txSig: "sig1" });
        }
        throw new Error(`unexpected url ${String(url)}`);
      },
    });

    await expect(api.bindWalletChallenge("w1")).resolves.toEqual({
      challenge: "c1",
      message: "m1",
      wallet: "w1",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(api.bindWallet({ challenge: "c1", signatureBase58: "s1" })).resolves.toEqual({ wallet: "w1" });
    await expect(api.depositBuild(250)).resolves.toEqual({
      txBase64: "tx",
      depositIntent: "di_1",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(api.depositSend({ depositIntent: "di_1", signedTxBase64: "tx-signed" })).resolves.toEqual({ txSig: "sig1" });

    expect(calls.map((call) => call.url)).toEqual([
      "http://x/v1/wallet/bind-challenge",
      "http://x/v1/wallet/bind",
      "http://x/v1/deposit/build",
      "http://x/v1/deposit/send",
    ]);
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { wallet: "w1" },
      { challenge: "c1", signatureBase58: "s1" },
      { amountCents: 250 },
      { depositIntent: "di_1", signedTxBase64: "tx-signed" },
    ]);
  });

  it("posts coin/scrap deltas and inventory ops to the account endpoints", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const mk = (body: unknown) =>
      createApi({
        baseUrl: "http://x", userId: "u",
        fetch: async (url, init) => {
          seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
          return res(200, body);
        },
      });

    expect(await mk({ coins: 30 }).coinsEarn({ amount: 30, ref: "e1" })).toEqual({ coins: 30 });
    expect(seen[0]).toEqual({ url: "http://x/v1/coins/earn", body: { amount: 30, ref: "e1" } });

    expect(await mk({ coins: 18 }).coinsSpend({ amount: 12, ref: "s1" })).toEqual({ coins: 18 });
    expect(seen[1].url).toBe("http://x/v1/coins/spend");

    expect(await mk({ scrap: 5 }).scrapEarn({ amount: 5, ref: "se1" })).toEqual({ scrap: 5 });
    expect(seen[2].url).toBe("http://x/v1/scrap/earn");

    expect(await mk({ carId: "orion", isNew: true, count: 1 }).inventoryGrant({ carId: "orion" }))
      .toEqual({ carId: "orion", isNew: true, count: 1 });
    expect(seen[3]).toEqual({ url: "http://x/v1/inventory/grant", body: { carId: "orion" } });

    expect(await mk({ seeded: true }).migrate({ coins: 10, scrap: 2, cars: { orion: 1 } }))
      .toEqual({ seeded: true });
    expect(seen[4].url).toBe("http://x/v1/migrate");
  });

  it("saves the account driver name through the profile endpoint", async () => {
    let seen: { url: string; method: string; body: unknown } | null = null;
    const api = createApi({
      baseUrl: "http://x",
      userId: "u",
      fetch: async (url, init) => {
        seen = {
          url: String(url),
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        return res(200, { driverName: "road_king" });
      },
    });

    await expect(api.setDriverName("road_king")).resolves.toEqual({ driverName: "road_king" });
    expect(seen).toEqual({
      url: "http://x/v1/profile/driver-name",
      method: "POST",
      body: { name: "road_king" },
    });
  });

  it("reads welcome status before posting the atomic claim", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createApi({
      baseUrl: "http://x",
      userId: "u",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return String(url).endsWith("/status")
          ? res(200, { pending: true })
          : res(200, { granted: true });
      },
    });

    await expect(api.welcomeStatus()).resolves.toEqual({ pending: true });
    await expect(api.claimWelcome()).resolves.toEqual({ granted: true });
    expect(calls).toEqual([
      { url: "http://x/v1/welcome/status", method: "GET", body: undefined },
      { url: "http://x/v1/welcome/claim", method: "POST", body: {} },
    ]);
  });

  it("maps a 402 coin spend to insufficient_balance", async () => {
    const api = createApi({ baseUrl: "http://x", userId: "u", fetch: async () => res(402, { error: "insufficient_balance" }) });
    await expect(api.coinsSpend({ amount: 9, ref: "x" })).rejects.toMatchObject({ code: "insufficient_balance" });
  });

  it("records and cursor-lists account trade history", async () => {
    const calls: Array<{ url: string; body?: unknown; tradeWallet?: string }> = [];
    const api = createApi({
      baseUrl: "http://x",
      userId: "u",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          tradeWallet: (init?.headers as Record<string, string>)["x-trade-wallet"],
        });
        return res(200, String(url).includes("cursor=")
          ? { items: [], nextCursor: null }
          : { id: "11111111-1111-4111-8111-111111111111" });
      },
    });
    const record = {
      id: "11111111-1111-4111-8111-111111111111",
      asset: "SOL" as const,
      dir: 1 as const,
      lev: 250,
      stakeBase: 10_000_000,
      entryPrice: 150,
      exitPrice: 151,
      openedAt: "2026-07-10T10:00:00.000Z",
      outcome: "cashout" as const,
      payoutBase: 11_000_000,
    };

    await api.recordTrade(record, "AliceWallet");
    await api.listTrades("next token");

    expect(calls).toEqual([
      { url: "http://x/v1/trades", body: record, tradeWallet: "AliceWallet" },
      { url: "http://x/v1/trades?limit=25&cursor=next%20token", body: undefined, tradeWallet: undefined },
    ]);
  });
});
