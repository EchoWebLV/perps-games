import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createGameSession, SESSION_TILL_ROUNDS } from "./game-session";
import { maxPayoutBase, type ChainRound } from "./chain-round";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const MINT = new PublicKey("8tZXkKuat9KoisUjFkq4kBUa1p746Mn4tj4i3st5Th1Y");

function fakeChain(over: Partial<ChainRound> = {}): ChainRound {
  return {
    address: "Fake111",
    readPlayerBalance: vi.fn(async () => 0n),
    readRoundStatus: vi.fn(async () => 0),
    readRound: vi.fn(async () => null),
    buyIn: vi.fn(async () => {}),
    ensureRoundInited: vi.fn(async () => {}),
    delegate: vi.fn(async () => {}),
    sliceFromPot: vi.fn(async () => {}),
    sweepTill: vi.fn(async () => {}),
    open: vi.fn(async () => ({ entryRaw: 0n, entryExpo: 8, entryHuman: 60000, deadlineTs: 0, feed: "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr" })),
    close: vi.fn(async () => ({ outcome: 0, outcomeName: "cashout", payout: 1_500_000n, exitRaw: 0n, exitHuman: 0, balance: 4_500_000n })),
    flip: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: -1, lev: 100, entryHuman: 60000 })),
    lever: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: 1, lev: 2000, entryHuman: 60000 })),
    scheduleCrank: vi.fn(async () => {}),
    forceClose: vi.fn(async () => ({ outcome: 3, outcomeName: "time", payout: 0n, exitRaw: 0n, exitHuman: 0, balance: 0n })),
    commitAndUndelegate: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    wrapForBuyIn: vi.fn(async () => {}),
    unwrapAll: vi.fn(async () => {}),
    ...over,
  };
}

describe("createGameSession", () => {
  it("init() reads and caches the L1 balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 5_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    expect(await s.init()).toBe(5_000_000n);
    expect(s.balance()).toBe(5_000_000n);
    expect(s.address()).toBe("Fake111");
  });

  it("ensureSession buys in when empty, inits the round, then delegates", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.buyIn).toHaveBeenCalledWith(2_000_000);
    expect(chain.ensureRoundInited).toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
    expect(s.delegated()).toBe(true);
  });

  it("ensureSession is idempotent once delegated (no second buy-in/delegate)", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.delegate).toHaveBeenCalledTimes(1);
    expect(chain.buyIn).toHaveBeenCalledTimes(1);
  });

  it("ensureSession skips buy-in when the player already has a balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 3_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("open arms the crank; crankArmed() reflects success", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    const opened = await s.open("BTC", 1, 2000, 1_000_000, 60, 200_000);
    expect(opened.entryHuman).toBe(60000);
    expect(chain.scheduleCrank).toHaveBeenCalled();
    expect(s.crankArmed()).toBe(true);
  });

  it("open still resolves when the crank fails to arm (degrades)", async () => {
    const chain = fakeChain({ scheduleCrank: vi.fn(async () => { throw new Error("escrow underfunded"); }) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("BTC", 1, 2000, 1_000_000, 60, 200_000);
    expect(s.crankArmed()).toBe(false);
  });

  it("noteLeverage drives the coalesced on-chain lever once delegated", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    s.noteLeverage(1000);
    await tick(); await tick();
    expect(chain.lever).toHaveBeenCalledWith(1000);
  });

  it("noteLeverage is a no-op before the session is delegated", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    s.noteLeverage(1000);
    await tick(); await tick();
    expect(chain.lever).not.toHaveBeenCalled();
  });

  it("a terminal-first background lever fires onSettled", async () => {
    const onSettled = vi.fn();
    const chain = fakeChain({
      lever: vi.fn(async () => ({ settled: true as const, outcome: 2, outcomeName: "liq", payout: 0n, exitRaw: 0n, exitHuman: 0, balance: 4_000_000n })),
    });
    const s = createGameSession({ mint: MINT, onSettled, injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    s.noteLeverage(2000);
    await tick(); await tick();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 2, outcomeName: "liq", payout: 0n }));
  });

  it("close caches the settled balance", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    const res = await s.close();
    expect(res.payout).toBe(1_500_000n);
    expect(s.balance()).toBe(4_500_000n);
  });

  it("endSession undelegates and clears the delegated flag", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    await s.endSession();
    expect(chain.commitAndUndelegate).toHaveBeenCalled();
    expect(s.delegated()).toBe(false);
  });

  it("slices the bet's worst-case payout off the pot before delegating, sweeps after undelegate", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(50_000_000, 10_000_000); // buy-in 0.05 SOL, bet 0.01 SOL
    expect(chain.sliceFromPot).toHaveBeenCalledWith(maxPayoutBase(10_000_000) * SESSION_TILL_ROUNDS); // session bankroll = N × one round's max payout
    expect((chain.sliceFromPot as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.delegate as any).mock.invocationCallOrder[0]);
    await s.endSession();
    expect((chain.commitAndUndelegate as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.sweepTill as any).mock.invocationCallOrder[0]);
  });
});
