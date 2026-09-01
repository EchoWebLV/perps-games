import { describe, expect, it, vi } from "vitest";
import type { Api } from "./api";
import type { EvmWalletPort } from "../evm/wallet-port";
import { CENTS_TO_USDC_BASE, SETTLE_OUTCOMES, createServerSession } from "./server-session";

const TREASURY = "0x9999999999999999999999999999999999999999";
const ADDR = "0x1111111111111111111111111111111111111111";

function fakeApi(over: Partial<Api> = {}, log: string[] = []): Api {
  return {
    me: async () => { log.push("me"); return { userId: "u", balance: 1000, coins: 0, scrap: 0, cars: [], openRoundId: null, access: [] }; },
    coinsEarn: async () => ({ coins: 0 }),
    coinsSpend: async () => ({ coins: 0 }),
    scrapEarn: async () => ({ scrap: 0 }),
    scrapSpend: async () => ({ scrap: 0 }),
    inventoryGrant: async (p) => ({ carId: p.carId, isNew: true, count: 1 }),
    inventoryMelt: async (p) => ({ carId: p.carId, melted: true, count: 0 }),
    migrate: async () => ({ seeded: true }),
    upgradesBuy: async (p) => ({ track: p.track, level: 1, coins: 0, scrap: 0 }),
    crateCommit: async () => ({ commitId: "c1", commitment: "0".repeat(64) }),
    openCrate: async () => ({
      carId: "car", isNew: true, count: 1, scrap: 0, scrapTotal: 0, coins: 0, levelKey: null,
      pity: { wooden: 0, silver: 0, gold: 0 },
    }),
    welcomeStatus: async () => ({ pending: false }),
    claimWelcome: async () => ({ granted: false }),
    redeemAccess: async () => ({ granted: false }),
    setDriverName: async (name) => ({ driverName: name }),
    openRound: async (p) => {
      log.push("open");
      return { roundId: "R1", asset: p.asset, dir: p.dir, lev: p.lev, stake: p.stake, entryRaw: 180.5, entryTsUs: 7_000_000 };
    },
    roundAction: async (a) => { log.push(`action:${a.kind}:${a.lev ?? a.dir}`); },
    closeRound: async () => {
      log.push("close");
      return { outcome: "cashout", payoutCoins: 240, pnlCoins: 40, equity: 1.2, exitRaw: 181.25, balance: 1040 };
    },
    markRound: async () => { log.push("mark"); return { status: "open" as const, stale: false, outcome: null, equity: 1.2, payoutCoins: 240, buffer: 0.9 }; },
    recordTrade: async (input) => ({ ...input, walletPublicKey: "w", pnlBase: 0, settledAt: "2026-01-01T00:00:00.000Z" }),
    listTrades: async () => ({ items: [], nextCursor: null }),
    bindWalletChallenge: async (wallet) => ({ challenge: "c", message: "m", wallet, expiresAt: "2026-01-01T00:00:00.000Z" }),
    bindWallet: async () => ({ wallet: ADDR }),
    depositBuild: async () => ({ txBase64: "", depositIntent: "di", expiresAt: "2026-01-01T00:00:00.000Z" }),
    depositSend: async () => ({ txSig: "s" }),
    walletBalance: async () => ({ wallet: null, balance: 0 }),
    depositAddress: async () => { log.push("depositAddress"); return { treasuryUsdcAta: TREASURY, boundWallet: ADDR }; },
    withdraw: async () => { log.push("withdraw"); return { withdrawalId: "w1", state: "awaiting_approval" }; },
    ...over,
  };
}

function fakePort(over: Partial<EvmWalletPort> = {}): EvmWalletPort {
  let address: string | null = null;
  return {
    kind: "dev-evm",
    connect: async () => { address = ADDR; return { address }; },
    reconnect: async () => (address ? { address } : null),
    disconnect: async () => { address = null; },
    currentAddress: () => address,
    signMessage: async () => "0xsig",
    sendUsdcTransfer: async () => "0xhash",
    usdcBalance: async () => 3_250_000n,
    ...over,
  };
}

const store = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); } };
};

function make(over: Partial<Api> = {}, portOver: Partial<EvmWalletPort> = {}) {
  const log: string[] = [];
  const api = fakeApi(over, log);
  const port = fakePort(portOver);
  const session = createServerSession({ api, port, store: store(), clock: { now: () => 0 } });
  return { api, port, session, log };
}

describe("createServerSession", () => {
  it("hydrates the cash balance from /v1/me and settles a dangling round", async () => {
    const { session, log } = make({
      me: async () => ({ userId: "u", balance: 750, coins: 0, scrap: 0, cars: [], openRoundId: "OLD", access: [] }),
    });

    expect(await session.hydrate()).toBe(750n);
    expect(session.balance()).toBe(750n);
    expect(log).toContain("close"); // the dangling round was settled, not left open
  });

  it("open() debits the stake from the cached balance so the chip is honest immediately", async () => {
    const { session } = make();
    await session.hydrate();

    const opened = await session.open("SOL", 1, 50, 300);

    expect(opened).toMatchObject({ roundId: "R1", entryHuman: 180.5, entryTs: 7 });
    expect(session.balance()).toBe(700n); // 1000 − 300
  });

  it("drains the coalesced lever queue BEFORE the close lands", async () => {
    const { session, log } = make();
    await session.hydrate();
    await session.open("SOL", 1, 50, 300);

    session.noteLeverage(500);
    await session.close();

    expect(log.filter((l) => l !== "me" && l !== "mark"))
      .toEqual(["open", "action:lever:500", "close"]);
  });

  it("close() maps the server settlement onto the shape the HUD already speaks", async () => {
    const { session } = make({
      closeRound: async () => ({ outcome: "liq", payoutCoins: 0, pnlCoins: -300, equity: 0, exitRaw: 176.5, balance: 700 }),
    });
    await session.hydrate();
    await session.open("SOL", 1, 50, 300);

    const settled = await session.close();

    expect(settled).toEqual({
      outcome: SETTLE_OUTCOMES.indexOf("liq"),
      outcomeName: "liq",
      payout: 0n,
      exitHuman: 176.5,
    });
    expect(session.balance()).toBe(700n); // the settlement's authoritative balance wins
  });

  it("close() is idempotent: a second call with no live round posts nothing and returns null", async () => {
    const { session, log } = make();
    await session.hydrate();
    await session.open("SOL", 1, 50, 300);

    await session.close();
    expect(await session.close()).toBeNull();
    expect(log.filter((l) => l === "close")).toHaveLength(1);
  });

  it("poll() reports the live mark while the round is open", async () => {
    const { session } = make();
    await session.hydrate();
    await session.open("SOL", 1, 50, 300);

    expect(await session.poll()).toEqual({
      settled: null,
      live: { equity: 1.2, payout: 240n, buffer: 0.9 },
    });
  });

  it("poll() settles the round when the server's mark says it already ended", async () => {
    const closeRound = vi.fn(async () => ({ outcome: "time", payoutCoins: 330, pnlCoins: 30, equity: 1.1, exitRaw: 182, balance: 1030 }));
    const { session } = make({
      markRound: async () => ({ status: "settled" as const, stale: false, outcome: "time", equity: 1.1, payoutCoins: 330, buffer: 1 }),
      closeRound,
    });
    await session.hydrate();
    await session.open("SOL", 1, 50, 300);

    const res = await session.poll();

    expect(res.settled).toEqual({
      outcome: SETTLE_OUTCOMES.indexOf("time"),
      outcomeName: "time",
      payout: 330n,
      exitHuman: 182,
    });
    // the settled mark is confirmed through the authoritative close, which carries the exit price
    expect(closeRound).toHaveBeenCalledWith({ roundId: "R1", reason: "expire" });
    expect(session.balance()).toBe(1030n);
  });

  it("deposit() converts cents to USDC base units and sends to the server's treasury", async () => {
    const sendUsdcTransfer = vi.fn(async () => "0xdeposit");
    const { session } = make({}, { sendUsdcTransfer });
    await session.connect();

    expect(await session.deposit(250)).toBe("0xdeposit");
    expect(sendUsdcTransfer).toHaveBeenCalledWith(TREASURY, 250n * CENTS_TO_USDC_BASE);
    expect(CENTS_TO_USDC_BASE).toBe(10_000n); // USDC has 6 decimals; the ledger has 2
  });

  it("withdraw() posts the cent amount and re-reads the authoritative balance", async () => {
    const withdraw = vi.fn(async () => ({ withdrawalId: "w1", state: "awaiting_approval" }));
    const { session } = make({
      withdraw,
      me: async () => ({ userId: "u", balance: 480, coins: 0, scrap: 0, cars: [], openRoundId: null, access: [] }),
    });

    await session.withdraw(250);

    expect(withdraw).toHaveBeenCalledWith({ amountCents: 250 });
    expect(session.balance()).toBe(480n);
  });

  it("loginFresh() drops the previous wallet first so the account chooser always opens", async () => {
    const calls: string[] = [];
    const { session } = make({}, {
      connect: async () => { calls.push("connect"); return { address: ADDR }; },
      disconnect: async () => { calls.push("disconnect"); },
    });

    expect(await session.loginFresh()).toBe(ADDR);
    expect(calls).toEqual(["disconnect", "connect"]);
  });

  it("reconnect() restores silently and reports whether anything was there", async () => {
    const { session } = make({}, { reconnect: async () => null });
    expect(await session.reconnect()).toBe(false);

    const live = make();
    await live.port.connect();
    expect(await live.session.reconnect()).toBe(true);
  });

  it("keeps the ER lifecycle questions answerable without an ER", async () => {
    const { session, log } = make();

    expect(session.delegated()).toBe(false);   // nothing is delegated on the server rail
    expect(session.crankArmed()).toBe(true);   // the server's settler is always on
    expect(await session.tableLimit()).toBeNull(); // the house cap is the server's business
    await expect(session.endSession()).resolves.toBeUndefined();
    expect(log).toEqual([]); // none of the shims touch the network
  });

  it("exposes the wallet's own USDC for the cashier", async () => {
    const { session } = make();
    await session.connect();
    expect(await session.walletUsdc()).toBe(3_250_000n);
  });
});
