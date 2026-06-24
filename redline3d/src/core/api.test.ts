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

  it("builds a play payment transaction through the play endpoint", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x", userId: "u",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { txBase64: "tx-play" }); },
    });

    const out = await api.playPaymentBuild(100);

    expect(out.txBase64).toBe("tx-play");
    expect(seen!.url).toBe("http://x/v1/play/payment/build");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ amountCents: 100 });
  });

  it("confirms a sent play payment signature through the play endpoint", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x", userId: "u",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { status: "credited", balance: 75 }); },
    });

    const out = await api.playPaymentConfirm("sig-play-123");

    expect(out).toEqual({ status: "credited", balance: 75 });
    expect(seen!.url).toBe("http://x/v1/play/payment/confirm");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ txSig: "sig-play-123" });
  });

  it("sends a signed play payment transaction through the play endpoint", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x", userId: "u",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { txSig: "sig-play-123" }); },
    });

    const out = await api.playPaymentSend("signed-play-tx");

    expect(out).toEqual({ txSig: "sig-play-123" });
    expect(seen!.url).toBe("http://x/v1/play/payment/send");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ signedTxBase64: "signed-play-tx" });
  });

  it("recovers a play payment when Privy sent it without returning a signature", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = createApi({
      baseUrl: "http://x", userId: "u",
      fetch: async (url, init) => { seen = { url: String(url), init: init ?? {} }; return res(200, { status: "credited", balance: 75, amountCents: 25 }); },
    });

    const out = await api.playPaymentRecover(25);

    expect(out).toEqual({ status: "credited", balance: 75, amountCents: 25 });
    expect(seen!.url).toBe("http://x/v1/play/payment/recover");
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ amountCents: 25 });
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
});
