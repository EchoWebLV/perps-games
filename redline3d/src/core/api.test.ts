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
});
