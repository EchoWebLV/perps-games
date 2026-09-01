import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The contract server/src/feed/symbols.ts claims in its docstring: adding a row to the symbol
 * table is the WHOLE job of adding a tradable asset server-side. Proving that needs a symbol the
 * hardcoded copies could never have known about, so the table is mocked with an extra equity row
 * and the real routes / protocol are asked whether they accept it.
 *
 * If any consumer goes back to its own `["BTC","ETH","SOL"]` literal, this fails.
 */
const EXTRA_KEY = "TSLA";

vi.mock("../feed/symbols.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../feed/symbols.js")>();
  const FEED_SYMBOLS = {
    ...actual.FEED_SYMBOLS,
    [EXTRA_KEY]: { hermesId: "b".repeat(64), display: EXTRA_KEY },
  };
  const keys = Object.keys(FEED_SYMBOLS);
  return {
    ...actual,
    FEED_SYMBOLS,
    FEED_ASSET_KEYS: keys as unknown as typeof actual.FEED_ASSET_KEYS,
    feedAssetKeys: () => [...keys],
    hermesIdOf: (k: string) => (FEED_SYMBOLS as Record<string, { hermesId: string }>)[k]?.hermesId,
  };
});

const { makeTestDb } = await import("./harness.js");
const { parseClientMessage } = await import("../presence/protocol.js");
const { FEED_ASSET_KEYS } = await import("../feed/symbols.js");

type TestCtx = Awaited<ReturnType<typeof makeTestDb>>;

let ctx: TestCtx;
const H = (user: string) => ({ "x-dev-user": user });

beforeEach(async () => {
  ctx = await makeTestDb();
});
afterEach(async () => {
  await ctx.close();
});

describe("feed symbol table is the single source for asset enums", () => {
  it("a table row the routes never hardcoded still opens a round", async () => {
    expect(FEED_ASSET_KEYS).toContain(EXTRA_KEY);
    ctx.feed.set(EXTRA_KEY, { price: 420, tsUs: 1_000_000 });
    await ctx.server.inject({ method: "POST", url: "/v1/dev/grant-coins", headers: H("alice"), payload: { amount: 100 } });

    const res = await ctx.server.inject({
      method: "POST",
      url: "/v1/round/open",
      headers: H("alice"),
      payload: { asset: EXTRA_KEY, dir: 1, lev: 50, stake: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entryRaw).toBe(420);
  });

  it("the /v1/prices poll rail reports every table row", async () => {
    ctx.feed.set(EXTRA_KEY, { price: 420, tsUs: 1_000_000 });
    const res = await ctx.server.inject({ method: "GET", url: "/v1/prices" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.live).sort()).toEqual([...FEED_ASSET_KEYS].sort());
    expect(body.prices[EXTRA_KEY]).toBe(420);
  });

  it("the presence highway frame accepts every table row", () => {
    const frame = {
      type: "highway",
      asset: EXTRA_KEY,
      roundPda: "1".repeat(40),
      dir: 1,
      lev: 50,
      laneSeed: 0,
      carId: "sedan",
    };
    expect(parseClientMessage(JSON.stringify(frame))).not.toBeNull();
  });
});
