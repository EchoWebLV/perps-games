import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createGameSession, SESSION_TILL_ROUNDS, type SettledInfo } from "./game-session";
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
    houseAvailable: vi.fn(async () => 1_000_000_000_000n), // roomy pot by default
    tillAvailable: vi.fn(async () => 0n),
    open: vi.fn(async () => ({ entryRaw: 0n, entryExpo: 8, entryHuman: 60000, deadlineTs: 0, feed: "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr" })),
    close: vi.fn(async () => ({ outcome: 0, outcomeName: "cashout", payout: 1_500_000n, exitRaw: 0n, exitHuman: 0, balance: 4_500_000n, deadlineTs: 0 })),
    flip: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: -1, lev: 100, entryHuman: 60000 })),
    lever: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: 1, lev: 2000, entryHuman: 60000 })),
    scheduleCrank: vi.fn(async () => {}),
    forceClose: vi.fn(async () => ({ outcome: 3, outcomeName: "time", payout: 0n, exitRaw: 0n, exitHuman: 0, balance: 0n, deadlineTs: 0 })),
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
    expect(chain.buyIn).toHaveBeenCalledWith(5_000_000); // 5-bet buffer (SESSION_BUFFER_BETS)
    expect(chain.ensureRoundInited).toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
    expect(s.delegated()).toBe(true);
  });

  it("ensureSession is idempotent once delegated (no second buy-in/delegate)", async () => {
    // L1 starts empty (drives the buy-in); the ER clone then shows the buffered ledger, so
    // the second GO rides the live session instead of rebuilding it.
    const chain = fakeChain({ readPlayerBalance: vi.fn(async (onEr?: boolean) => (onEr ? 5_000_000n : 0n)) });
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
        dir: 1, lev: 50, entryRaw: 0n, entryExpo: 8, entryHuman: 0, entryTs: 0, exitRaw: 0n, exitHuman: 0, deadlineTs: 0,
      })),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.sliceFromPot).toHaveBeenCalled();
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("adopts a genuinely live session (L1 owners delegated) without re-buying or re-slicing", async () => {
    const chain = fakeChain({
      delegationState: vi.fn(async () => "reuse" as const),
      readPlayerBalance: vi.fn(async () => 5_000_000n), // funded — covers the bet, so it rides
    });
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

  it("arms 24 hours of one-second ticks for an open-ended Highway round", async () => {
    const chain = fakeChain({
      open: vi.fn(async () => ({ entryRaw: 60_000n, entryExpo: 8, entryHuman: 60000, entryTs: 100, deadlineTs: -123, feed: "F" })),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("SOL", 1, 250, 1_000_000, -1, 200_000);
    expect(chain.scheduleCrank).toHaveBeenCalledWith(expect.objectContaining({ iterations: 86_400 }));
  });

  it("exposes an adopted open Highway round after reconnect", async () => {
    const open = {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 0n,
      dir: -1, lev: 250, entryRaw: 60_000n, entryExpo: 8, entryHuman: 60000,
      entryTs: 100, exitRaw: 0n, exitHuman: 0, deadlineTs: -123,
    };
    const chain = fakeChain({
      delegationState: vi.fn(async () => "reuse" as const),
      readRound: vi.fn(async () => open),
    });
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "Fake111" })),
      reconnect: vi.fn(async () => ({ address: "Fake111" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => "Fake111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port, injectChain: chain, injectAddress: "Fake111" });
    expect(await s.reconnect()).toBe(true);
    expect(port.connect).not.toHaveBeenCalled();
    expect(s.liveRound()).toEqual(open);
  });

  it("does not overlap Highway crank coverage when the same round reconnects", async () => {
    const values = new Map<string, string>();
    const coverageStore = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const open = {
      status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 0n,
      dir: 1, lev: 250, entryRaw: 60_000n, entryExpo: 8, entryHuman: 60000,
      entryTs: 100, exitRaw: 0n, exitHuman: 0, deadlineTs: -987,
    };
    const scheduleCrank = vi.fn(async () => {});
    const make = () => createGameSession({
      mint: MINT, onSettled: vi.fn(), injectAddress: "Fake111", coverageStore,
      injectChain: fakeChain({
        delegationState: vi.fn(async () => "reuse" as const),
        readRound: vi.fn(async () => open),
        scheduleCrank,
      }),
    });

    await make().init();
    await make().init();
    expect(scheduleCrank).toHaveBeenCalledTimes(1);
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
    let observedExit = 0;
    const onSettled = vi.fn((info: SettledInfo) => { observedExit = info.exitHuman; });
    const chain = fakeChain({
      lever: vi.fn(async () => ({ settled: true as const, outcome: 2, outcomeName: "liq", payout: 0n, exitRaw: 0n, exitHuman: 60000, balance: 4_000_000n, deadlineTs: 0 })),
    });
    const s = createGameSession({ mint: MINT, onSettled, injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    s.noteLeverage(2000);
    await tick(); await tick();
    expect(observedExit).toBe(60000);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: 2, outcomeName: "liq", payout: 0n, exitHuman: 60000 }));
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
    // the LAST sweep is endSession's (ensureSession also sweeps once, up front, to self-heal strands)
    expect((chain.commitAndUndelegate as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.sweepTill as any).mock.invocationCallOrder.at(-1));
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

  it("reconnect() silently restores a returning session (port.reconnect resolves) and reads the balance", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 4_000_000n) });
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      reconnect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port, injectChain: fakeChain({ readPlayerBalance: vi.fn(async () => 4_000_000n) }) });
    void chain;
    expect(await s.reconnect()).toBe(true);
    expect(port.reconnect).toHaveBeenCalled();
    expect(port.connect).not.toHaveBeenCalled(); // silent path — never triggers a login modal
    expect(s.balance()).toBe(4_000_000n);
  });

  it("reconnect() returns false (and stays untouched) when there is no session to restore", async () => {
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      reconnect: vi.fn(async () => null),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => null,
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    expect(await s.reconnect()).toBe(false);
    expect(port.connect).not.toHaveBeenCalled();
    expect(s.balance()).toBe(0n);
  });

  it("re-adopted session that can't cover the bet is quietly ended + rebuilt with a wallet top-up", async () => {
    // Live-hit: after a few rounds the delegated ledger dropped below the bet; adopt had no
    // top-up path (a delegated ledger can't buy in) so GO bounced "Not enough SOL" while the
    // wallet held plenty. The bet must flow from the wallet: end the session, rebuild, top up.
    const chain = fakeChain({
      delegationState: vi.fn(async () => "reuse" as const),
      readPlayerBalance: vi.fn(async () => 40_000n), // covers neither the 1_000_000 stake nor a round
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.commitAndUndelegate).toHaveBeenCalled(); // old session ended under the hood
    expect(chain.buyIn).toHaveBeenCalledWith(5_000_000);  // topped up from the wallet (5-bet buffer)
    expect(chain.delegate).toHaveBeenCalled();            // fresh session carved + delegated
    expect(s.delegated()).toBe(true);
  }, 15_000);

  it("falls back to L1 truth when the ER clone lags right after delegation (stale-0 read)", async () => {
    // The ER serves stale copies around (un)delegation — a bare post-delegate ER read
    // returned 0 for a funded player and GO bounced with "Not enough SOL" (live-hit).
    const chain = fakeChain({
      readPlayerBalance: vi.fn(async (onEr?: boolean) => (onEr ? 0n : 5_000_000n)),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(s.balance()).toBe(5_000_000n); // L1 accounting, not the stale ER 0
  }, 15_000);

  it("ensureSession reclaims a leftover till (missed sweep) BEFORE slicing a fresh one", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.sweepTill).toHaveBeenCalled();
    expect((chain.sweepTill as any).mock.invocationCallOrder[0])
      .toBeLessThan((chain.sliceFromPot as any).mock.invocationCallOrder[0]);
  });

  it("ensureSession tops up from the wallet when the play balance is below the stake (not only when 0)", async () => {
    const chain = fakeChain({ readPlayerBalance: vi.fn(async () => 2_000_000n) }); // has 0.002, bets 0.01
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(100_000_000, 10_000_000);
    expect(chain.buyIn).toHaveBeenCalledWith(100_000_000); // topped up so the round can open
  });

  it("shrinks the bankroll slice to what the pot can host (1 round beats refusing)", async () => {
    // Pot can back ~1.5 rounds of this bet: take ONE round's worth and play — never refuse
    // while even a single round is coverable ("Tables are full" was hiding a playable table).
    const oneRound = maxPayoutBase(1_000_000);
    const chain = fakeChain({ houseAvailable: vi.fn(async () => BigInt(Math.floor(oneRound * 1.5))) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.sliceFromPot).toHaveBeenCalledWith(oneRound); // degraded from 3× to 1×
    expect(chain.delegate).toHaveBeenCalled();
  });

  it("refuses ONLY below one round's backing, and then names the actual table limit", async () => {
    // Pot can back at most a 0.02-SOL bet (23.75x lock) — a 0.05 bet must be told the limit.
    const chain = fakeChain({ houseAvailable: vi.fn(async () => BigInt(maxPayoutBase(20_000_000))) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await expect(s.ensureSession(100_000_000, 50_000_000)).rejects.toMatchObject({
      code: "bankroll_full",
      message: expect.stringContaining("0.02"),
    });
    expect(chain.sliceFromPot).not.toHaveBeenCalled();
  });

  it("keeps the full 3-round slice when the pot is roomy", async () => {
    const chain = fakeChain();
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.sliceFromPot).toHaveBeenCalledWith(maxPayoutBase(1_000_000) * SESSION_TILL_ROUNDS);
  });

  it("stages a buffer of several bets so the heavy rebuild stays rare (capped by the wallet)", async () => {
    // buy-in floor 2M, bet 1M → buffer target = 5 bets = 5M, wallet can spare only 3.5M → 3.5M
    const chain = fakeChain({ walletFunds: vi.fn(async () => ({ sol: 1_000_000_000n, stake: 3_500_000n })) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000);
    expect(chain.buyIn).toHaveBeenCalledWith(3_500_000);
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

  it("logout() reports a Privy disconnect failure instead of pretending sign-out completed", async () => {
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => { throw new Error("privy_down"); }),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    await expect(s.logout()).rejects.toThrow("privy_down");
    expect(port.disconnect).toHaveBeenCalled();
    expect(s.balance()).toBe(0n);
  });

  it("loginFresh() signs the wallet out FIRST, then rebuilds — the gate's SIGN IN always offers the account picker", async () => {
    // A persisted Privy session makes connect() silently resume the previous account; the
    // gate's SIGN IN must clear it so the login modal (the account chooser) always shows.
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr2222" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => "PrivyAddr2222",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port, injectChain: fakeChain({ readPlayerBalance: vi.fn(async () => 7_000_000n) }) });
    await s.init();
    expect(await s.loginFresh()).toBe(7_000_000n); // the NEW account's balance, freshly read
    expect(port.disconnect).toHaveBeenCalled();
    expect(s.delegated()).toBe(false);
  });

  it("signMessage delegates to the wallet port", async () => {
    const signed = new Uint8Array([9, 8, 7]);
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => {}),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async (_m: Uint8Array) => signed),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    expect(await s.signMessage(new TextEncoder().encode("hi"))).toEqual(signed);
    expect(port.signMessage).toHaveBeenCalled();
  });

  it("loginFresh() propagates a failed sign-out — never falls through to silently resume the old account", async () => {
    const port = {
      kind: "web-standard" as const,
      connect: vi.fn(async () => ({ address: "PrivyAddr1111" })),
      disconnect: vi.fn(async () => { throw new Error("privy_logout_timeout"); }),
      currentAddress: () => "PrivyAddr1111",
      signMessage: vi.fn(async () => new Uint8Array()),
      signTransaction: vi.fn(async (b64: string) => b64),
    };
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), port });
    await expect(s.loginFresh()).rejects.toThrow("privy_logout_timeout");
    expect(port.connect).not.toHaveBeenCalled(); // the session we failed to clear must NOT be resumed
  });

  it("tableLimit() inverts max_payout exactly: largest stake whose lock fits pot+till", async () => {
    // 0.475 SOL pot → 0.02 SOL limit — the live devnet state that surfaced the table-limit message
    const chain = fakeChain({ houseAvailable: vi.fn(async () => 475_000_000n) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    const lim = Number((await s.tableLimit())!);
    expect(lim).toBe(20_000_000);
    expect(maxPayoutBase(lim)).toBeLessThanOrEqual(475_000_000);
    expect(maxPayoutBase(lim + 1)).toBeGreaterThan(475_000_000);
  });

  it("tableLimit() counts the session till buffer alongside the pot", async () => {
    const chain = fakeChain({
      houseAvailable: vi.fn(async () => 237_500_000n),
      tillAvailable: vi.fn(async () => 237_500_000n),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    expect(Number((await s.tableLimit())!)).toBe(20_000_000);
  });

  it("tableLimit() is null when the read fails (caller keeps the last cap)", async () => {
    const chain = fakeChain({ houseAvailable: vi.fn(async () => { throw new Error("rpc down"); }) });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    expect(await s.tableLimit()).toBeNull();
  });
});

describe("round identity — the previous round's settled corpse must not settle THIS round", () => {
  // The ER router has no read-after-write guarantee across nodes: right after `open`,
  // reads can still serve the PREVIOUS round's settled state (status 2). Live-hit as
  // phantom "Settled at ×…" toasts that killed brand-new rounds ~seconds after GO,
  // leaving the real round to run orphaned until the crank reaped it.
  const snap = (deadlineTs: number, over: Record<string, unknown> = {}) => ({
    status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 0n, dir: 1, lev: 50,
    entryRaw: 8_100_000_000n, entryExpo: 8, entryHuman: 81, entryTs: deadlineTs, exitRaw: 0n, exitHuman: 0, deadlineTs, ...over,
  });
  const corpse = (deadlineTs: number) => snap(deadlineTs, { status: 2, outcome: 3, outcomeName: "time", payout: 47_000_000n });

  it("poll() suppresses a settled snap whose deadlineTs is not this round's", async () => {
    // reconcile-read (pre-open), verify-read, stale corpse, real settle
    const reads = [corpse(1000), snap(2000), corpse(1000), corpse(2000)];
    const chain = fakeChain({
      open: vi.fn(async () => ({ entryRaw: 8_100_000_000n, entryExpo: 8, entryHuman: 81, deadlineTs: 2000, feed: "F" })),
      readRound: vi.fn(async () => reads.shift() ?? corpse(2000)),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);
    expect(await s.poll()).toBeNull();               // previous round's corpse → suppressed
    expect((await s.poll())?.status).toBe(2);        // THIS round's settle → surfaced
  });

  it("a lever fetch that raced onto the corpse does NOT fire onSettled; the real settle does", async () => {
    // The guard keys on owner+deadline_ts (see roundKey): the corpse (a DIFFERENT round, an older
    // deadline) is swallowed; THIS round's settle (matching deadline) fires.
    let leverResult: any = { settled: true, outcome: 3, outcomeName: "time", payout: 47_000_000n, exitRaw: 0n, exitHuman: 0, balance: 1n, entryTs: 1000, entryRaw: 8_100_000_000n, deadlineTs: 1000 };
    const chain = fakeChain({
      delegationState: vi.fn(async () => "reuse" as const),
      open: vi.fn(async () => ({ entryRaw: 8_100_000_000n, entryExpo: 8, entryHuman: 81, entryTs: 2000, deadlineTs: 2000, feed: "F" })),
      readRound: vi.fn(async () => snap(2000)),
      lever: vi.fn(async () => leverResult),
    });
    const onSettled = vi.fn();
    const s = createGameSession({ mint: MINT, onSettled, injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);

    s.noteLeverage(40);
    await tick(); await tick();
    expect(onSettled).not.toHaveBeenCalled();        // corpse (round @1000 ≠ round @2000) swallowed

    leverResult = { ...leverResult, entryTs: 2000, entryRaw: 8_100_000_000n, deadlineTs: 2000 };
    s.noteLeverage(30);
    await tick(); await tick();
    expect(onSettled).toHaveBeenCalledTimes(1);      // genuine settle of THIS round
  });

  it("open() trusts the verified live read over its own possibly-stale fetch", async () => {
    // open's post-send fetch itself hit the corpse (old deadline/entry); the verify read
    // sees the live round — its identity and entry win, and the guard keys on it.
    const reads = [corpse(1000), snap(2000, { entryHuman: 81 }), corpse(1000)]; // reconcile, verify, poll
    const chain = fakeChain({
      open: vi.fn(async () => ({ entryRaw: 7_900_000_000n, entryExpo: 8, entryHuman: 79, deadlineTs: 1000, feed: "F" })),
      readRound: vi.fn(async () => reads.shift() ?? null),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    const opened = await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);
    expect(opened.deadlineTs).toBe(2000);
    expect(opened.entryHuman).toBe(81);
    expect(await s.poll()).toBeNull();               // corpse at the OLD deadline still suppressed
  });

  it("poll surfaces a crank settle after a flip re-anchored the entry (rounds must never stick open)", async () => {
    // REGRESSION (live P0): flip/lever REWRITE round.entry_raw on-chain (the mid-round re-anchor,
    // lib.rs:754/:820); deadline_ts is written once at open and never again. A round identity that
    // folds entry_raw in false-mismatches every post-flip settle — poll() then discards the genuine
    // crank/deadline settle and the round sticks OPEN in the HUD forever (the user-reported bug).
    const DL = 2222;
    const openLive = snap(DL, { entryRaw: 60_000n, entryTs: 1111 });                     // entry snapshot at open
    const settle = snap(DL, { entryRaw: 60_500n, entryTs: 1111, status: 2, outcome: 3,   // re-anchored, then crank-settled
                              outcomeName: "time", payout: 47_000_000n });
    const reads = [null, openLive]; // open: reconcile (nothing stale) → verify read (stamps curKey)
    const chain = fakeChain({
      open: vi.fn(async () => ({ entryRaw: 60_000n, entryExpo: 8, entryHuman: 60000, entryTs: 1111, deadlineTs: DL, feed: "F" })),
      readRound: vi.fn(async () => (reads.length ? reads.shift()! : settle)), // post-open reads = the re-anchored settle
      flip: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: -1, lev: 50, entryHuman: 60005 })), // re-anchor, still open
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);
    await s.flip(-1); // re-anchors entry_raw on-chain (60_000n → 60_500n); round stays open
    const settled = await s.poll();
    expect(settled).not.toBeNull();       // the genuine settle of THIS round must surface (was null — the bug)
    expect(settled?.status).toBe(2);
    expect(settled?.outcomeName).toBe("time");
  });

  it("a background lever settle after a flip re-anchored the entry fires onSettled (not 'ignored stale settle')", async () => {
    // Same re-anchor root cause on the lever guard (game-session.ts:136): a genuine lever-triggered
    // settle carries the re-anchored entry_raw, so a composite-key guard drops it as a stale corpse.
    // Identity keyed on owner+deadline_ts recognizes it as THIS round → onSettled fires.
    const DL = 2222;
    const openLive = snap(DL, { entryRaw: 60_000n, entryTs: 1111 });
    const reads = [null, openLive]; // open: reconcile → verify (stamps curKey at entry_raw 60_000n)
    const onSettled = vi.fn();
    const chain = fakeChain({
      readPlayerBalance: vi.fn(async (onEr?: boolean) => (onEr ? 5_000_000n : 0n)), // funded ER clone → no post-delegate poll wait
      open: vi.fn(async () => ({ entryRaw: 60_000n, entryExpo: 8, entryHuman: 60000, entryTs: 1111, deadlineTs: DL, feed: "F" })),
      readRound: vi.fn(async () => (reads.length ? reads.shift()! : openLive)),
      flip: vi.fn(async () => ({ settled: false as const, banked: 0n, dir: -1, lev: 50, entryHuman: 60005 })),
      // the lever hits terminal after its own re-anchor: settle carries entry_raw 60_500n (≠ curKey's 60_000n)
      lever: vi.fn(async () => ({ settled: true as const, outcome: 3, outcomeName: "time", payout: 47_000_000n, exitRaw: 0n, exitHuman: 0, balance: 4_000_000n, entryTs: 1111, entryRaw: 60_500n, deadlineTs: DL })),
    });
    const s = createGameSession({ mint: MINT, onSettled, injectChain: chain, injectAddress: "Fake111" });
    await s.init();
    await s.ensureSession(2_000_000, 1_000_000); // delegate so noteLeverage drives the on-chain lever
    await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);
    await s.flip(-1); // re-anchors entry_raw on-chain
    s.noteLeverage(30);
    await tick(); await tick();
    expect(onSettled).toHaveBeenCalledTimes(1); // the genuine settle of THIS round (was dropped as stale — the bug)
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcomeName: "time", payout: 47_000_000n }));
  });
});

describe("open() retry after an uncertain confirm must not settle the round it just opened", () => {
  // A round that OPENED on-chain but whose confirmation flaked makes main retry session.open().
  // The reconcile at open()'s top must recognize that in-flight round by its identity and ADOPT
  // it — never CLOSE it as a stale corpse — or the retry instantly settles the player's fresh round.
  const live = {
    status: 1, outcome: 0, outcomeName: "cashout", payout: 0n, banked: 0n, dir: 1, lev: 50,
    entryRaw: 8_100_000_000n, entryExpo: 8, entryHuman: 81, entryTs: 555, exitRaw: 0n, exitHuman: 0, deadlineTs: 5000,
  };
  // reads.shift() but keep an explicit null distinct from "array empty" (?? would swallow the null)
  const reader = (reads: (typeof live | null)[]) => vi.fn(async () => (reads.length ? reads.shift()! : live));

  it("adopts the just-opened round on the retry (no close, no re-open)", async () => {
    let opens = 0;
    // attempt-1 reconcile (nothing yet) → attempt-1 post-reject capture → attempt-2 reconcile
    const chain = fakeChain({
      open: vi.fn(async () => {
        opens++;
        if (opens === 1) throw new Error("confirm timeout"); // landed on-chain but unconfirmed
        throw new Error("must not re-open — the in-flight round must be adopted");
      }),
      readRound: reader([null, live, live]),
      close: vi.fn(async () => { throw new Error("must NOT settle the fresh round"); }) as any,
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "OwnerA" });
    await s.init();
    await expect(s.open("SOL", 1, 50, 1_000_000, 60, 200_000)).rejects.toThrow("confirm timeout"); // attempt-1
    const opened = await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);                              // attempt-2 → adopt
    expect(opened.deadlineTs).toBe(5000);
    expect(opened.entryHuman).toBe(81);
    expect(chain.close).not.toHaveBeenCalled(); // never settled our own fresh round
    expect(opens).toBe(1);                       // never re-opened — adopted the in-flight round
    expect(s.crankArmed()).toBe(true);           // the adopted round got its crank armed
  });

  it("still settles a genuinely stale PRIOR round (the legitimate reconcile is preserved)", async () => {
    // No uncertain attempt happened (pendingOpenKey null), so an open round found at entry is a real
    // leftover corpse from a prior session — it must be closed so a fresh round can start.
    const stale = { ...live, deadlineTs: 4000, entryTs: 444 };
    const chain = fakeChain({
      readRound: reader([stale, live, live]), // reconcile sees the stale round → close, then the new round
      open: vi.fn(async () => ({ entryRaw: 8_100_000_000n, entryExpo: 8, entryHuman: 81, entryTs: 555, deadlineTs: 5000, feed: "F" })),
    });
    const s = createGameSession({ mint: MINT, onSettled: vi.fn(), injectChain: chain, injectAddress: "OwnerA" });
    await s.init();
    const opened = await s.open("SOL", 1, 50, 1_000_000, 60, 200_000);
    expect(chain.close).toHaveBeenCalledTimes(1); // the prior corpse was settled
    expect(opened.deadlineTs).toBe(5000);
  });
});
