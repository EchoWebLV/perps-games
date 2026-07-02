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
    houseAvailable: vi.fn(async () => 1_000_000_000_000n), // roomy pot by default
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
