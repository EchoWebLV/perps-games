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
    delegationState: vi.fn(async () => "fresh" as const),
    buyIn: vi.fn(async () => {}),
    ensureRoundInited: vi.fn(async () => {}),
    delegate: vi.fn(async () => {}),
    sliceFromPot: vi.fn(async () => {}),
    sweepTill: vi.fn(async () => {}),
    walletFunds: vi.fn(async () => ({ sol: 1_000_000_000n, stake: 1_000_000_000n })),
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

  it("does NOT adopt a stale ER round when L1 says undelegated (End→GO wedge regression)", async () => {
    // After endSession the ER keeps serving a stale copy of the settled Round for a while,
    // so a bare ER read is NOT a liveness signal. Adopting on it skips buy-in/slice/delegate
    // and every subsequent open fails HouseUndercapitalized against the empty till.
    const chain = fakeChain({
      delegationState: vi.fn(async () => "fresh" as const),
      readRound: vi.fn(async () => ({
        status: 2, outcome: 3, outcomeName: "time", payout: 47_139_000n, banked: 0n,
        dir: 1, lev: 50, entryRaw: 0n, entryExpo: 8, entryHuman: 0, exitRaw: 0n, exitHuman: 0, deadlineTs: 0,
      })),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.sliceFromPot).toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("adopts a genuinely live session (L1 owners delegated) without re-buying or re-slicing", async () => {
    const chain = fakeChain({ delegationState: vi.fn(async () => "reuse" as const) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.sliceFromPot).not.toHaveBeenCalled();
    expect(chain.delegate).not.toHaveBeenCalled();
    expect(s.delegated()).toBe(true);
  });

  it("ensureSession skips buy-in when the player already has a balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 3_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("open threads refundFp (Flintstone airbag) through to the chain, defaulting 0", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    await s.open("BTC", 1, 100, 1_000_000, 60, 200_000, 0, 0, 0, 200_000);
    expect(vi.mocked(chain.open).mock.calls[0][9]).toBe(200_000); // refundFp stamped on-chain at open
    await s.open("BTC", 1, 100, 1_000_000, 60, 200_000);
    expect(vi.mocked(chain.open).mock.calls[1][9] ?? 0).toBe(0); // every other car: no airbag
  });

  it("walletSol() reads the owner wallet's native SOL (wallet panel display)", async () => {
    const chain = fakeChain({ walletFunds: vi.fn(async () => ({ sol: 250_000_000n, stake: 0n })) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    expect(await s.walletSol()).toBe(250_000_000n);
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

  it("sizes the crank schedule to the round's duration (a 90s Heavy-Load round must not outlive its crank)", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("BTC", 1, 500, 1_000_000, 90, 200_000);
    const opts = vi.mocked(chain.scheduleCrank).mock.calls[0][0];
    // 1s ticks → iterations must cover the whole round + settle margin. The old fixed 70
    // exhausted at ~70s, so a 90s round's deadline was never observed (live-found on devnet).
    expect(opts?.iterations ?? 70).toBeGreaterThanOrEqual(100);
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

  it("init() adopts a still-delegated session (log-out→log-in mid-session) so cash-out sees live ER state", async () => {
    const chain = fakeChain({
      delegationState: vi.fn(async () => "reuse" as const),
      readPlayerBalance: vi.fn(async (onEr?: boolean) => (onEr ? 7_000_000n : 1n)),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    expect(await s.init()).toBe(7_000_000n); // the ER copy, not the stale L1 one
    expect(s.delegated()).toBe(true);
  });

  it("ensureSession fails fast with a player-friendly error when the wallet has no SOL (fresh Privy wallet)", async () => {
    const chain = fakeChain({ walletFunds: vi.fn(async () => ({ sol: 0n, stake: 0n })) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await expect(s.ensureSession(100_000_000, 10_000_000)).rejects.toMatchObject({ code: "wallet_unfunded" });
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.sliceFromPot).not.toHaveBeenCalled();
  });

  it("ensureSession fails fast when the stake-token wallet can't cover the buy-in", async () => {
    const chain = fakeChain({ walletFunds: vi.fn(async () => ({ sol: 1_000_000_000n, stake: 0n })) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await expect(s.ensureSession(100_000_000, 10_000_000)).rejects.toMatchObject({ code: "wallet_unfunded" });
    expect(chain.buyIn).not.toHaveBeenCalled();
  });

  it("under the wSOL mint, SOL must cover the buy-in itself (wrap pulls native SOL)", async () => {
    const chain = fakeChain({ walletFunds: vi.fn(async () => ({ sol: 50_000_000n, stake: 0n })) });
    const wsol = new PublicKey("So11111111111111111111111111111111111111112");
    const s = createGameSession({ mint: wsol, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await expect(s.ensureSession(100_000_000, 10_000_000)).rejects.toMatchObject({ code: "wallet_unfunded" });
    expect(chain.wrapForBuyIn).not.toHaveBeenCalled();
  });

  it("skips the stake check when the play balance is already funded (no buy-in needed)", async () => {
    const chain = fakeChain({
      readPlayerBalance: vi.fn(async () => 500_000_000n),
      walletFunds: vi.fn(async () => ({ sol: 100_000_000n, stake: 0n })),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(100_000_000, 10_000_000); // no throw: fees covered, buy-in not needed
    expect(chain.buyIn).not.toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("logout() disconnects the wallet port so the next sign-in starts fresh (Privy account switch)", async () => {
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    await s.logout();
    expect(port.disconnect).toHaveBeenCalled();
    expect(s.delegated()).toBe(false);
    expect(s.balance()).toBe(0n);
  });

  it("logout() still resets state when the port disconnect fails", async () => {
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => { throw new Error("privy_down"); }),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    await expect(s.logout()).resolves.toBeUndefined();
    expect(port.disconnect).toHaveBeenCalled();
    expect(s.balance()).toBe(0n);
  });
});
