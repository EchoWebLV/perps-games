import { describe, expect, it, vi } from "vitest";
import { createPaddockStaging, STAKE_BUFFER_BETS, FEE_FLOOR_LAMPORTS } from "./paddock-staging";
import { LiveStakesError } from "./paddock";
import type { CashOutStep, OnboardStep, RaceSnap, BettorSnap } from "./paddock";
import type { DelegateState } from "./chain-round";

const raceSnap = (over: Partial<RaceSnap> = {}): RaceSnap => ({
  mint: "m", seq: 10n, phase: 1, phaseEndsTs: 0,
  entrants: [0, 1, 2, 3, 4, 5, 6, 7], strengths: [], pools: [], total: 0n,
  order: [], seed: new Uint8Array(32), feed: "f", rakeAccrued: 0n,
  history: [], ...over,
});
const bettorSnap = (balance: bigint, over: Partial<BettorSnap> = {}): BettorSnap => ({
  balance, stakes: new Array(8).fill(0n), raceSeq: null, ...over,
});

// Declared with the real signatures (not `async () => {}`) so `mock.calls[0][0]` is a typed
// tuple element rather than an index into `[]`.
const clientDefaults = () => ({
  delegationState: vi.fn(async (): Promise<DelegateState> => "fresh"),
  bettorSnapshot: vi.fn(async (): Promise<BettorSnap | null> => null),
  raceSnapshot: vi.fn(async (): Promise<RaceSnap | null> => raceSnap()),
  walletFunds: vi.fn(async () => ({ sol: 1_000_000_000n, stake: 0n })),
  bettorL1Balance: vi.fn(async () => 0n),
  ensureBettor: vi.fn(async (_amount: number | bigint, _onStep?: (step: OnboardStep) => void) => {}),
  cashOut: vi.fn(async (_onStep?: (step: CashOutStep) => void) => 0n),
});
type FakeClient = ReturnType<typeof clientDefaults>;

// Overrides are typed against the client shape, so a misspelled key is a compile error
// rather than a silently-ignored default.
function fakeClient(over: Partial<FakeClient> = {}): FakeClient {
  return { ...clientDefaults(), ...over };
}

const STAKE = 50_000_000n; // $5

describe("createPaddockStaging", () => {
  it("fresh wallet: stages a 5-bet buffer, capped by wallet minus the fee floor", async () => {
    const client = fakeClient();
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
    expect(client.ensureBettor.mock.calls[0][0]).toBe(STAKE * BigInt(STAKE_BUFFER_BETS)); // 0.25 SOL fits under 1 SOL - floor
    expect(s.status().state).toBe("ready");
  });

  it("caps the buffer at what the wallet can spare", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: STAKE + FEE_FLOOR_LAMPORTS + 1_000_000n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor.mock.calls[0][0]).toBe(STAKE + 1_000_000n);
  });

  it("fails fast on an unfunded wallet without spending anything", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: 1_000_000n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).not.toHaveBeenCalled();
    expect(s.status().state).toBe("error");
    expect(s.status().error).toMatch(/needs SOL/i);
  });

  it("delegated with a covering balance: ready, no sends", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(STAKE)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.ensureBettor).not.toHaveBeenCalled();
    expect(client.cashOut).not.toHaveBeenCalled();
    expect(s.status().state).toBe("ready");
    expect(s.betableBase()).toBe(STAKE);
  });

  it("counts a claimable past win as betable (place_bet auto-settles it)", async () => {
    // ticket rode race 5, slot 2 won at x1.9; stakes[2] = $5 → claimable
    const history = new Array(32).fill({ seq: 0n, winner: 0, multFp: 0n });
    history[5] = { seq: 5n, winner: 2, multFp: 1_900_000n };
    const stakes = new Array(8).fill(0n); stakes[2] = STAKE;
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n, { raceSeq: 5n, stakes })),
      raceSnapshot: vi.fn(async () => raceSnap({ seq: 10n, history })),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).not.toHaveBeenCalled(); // claimable covers the stake — no rebuild
    expect(s.status().state).toBe("ready");
    expect(s.betableBase()).toBe((STAKE * 1_900_000n) / 1_000_000n);
  });

  it("delegated and short with nothing to claim: silent rebuild (cashOut then re-stage)", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(1_000_000n)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).toHaveBeenCalledTimes(1);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
    expect(s.status().state).toBe("ready");
  });

  it("a refill blocked by live stakes retries quietly — no error state", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n)),
      cashOut: vi.fn(async () => { throw new LiveStakesError("riding"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("idle");
    expect(s.status().error).toBeNull();
  });

  it("is single-flight: concurrent ensure() runs once", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const client = fakeClient({ ensureBettor: vi.fn(async () => gate) });
    const s = createPaddockStaging({ client });
    const a = s.ensureNow(STAKE);
    const b = s.ensureNow(STAKE);
    resolve();
    await Promise.all([a, b]);
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
  });

  it("a returning delegated player still gets a wallet SOL read (one-number display)", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(STAKE)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.walletSolBase()).toBe(1_000_000_000n);
  });

  it("a failed bettor read on a live seat retries quietly — never a rebuild", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => { throw new Error("502 from ER"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).not.toHaveBeenCalled();
    expect(s.status().state).toBe("idle");
    expect(s.status().error).toBeNull();
  });

  it("a torn pair blocked by live stakes also retries quietly", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "busy" as const),
      cashOut: vi.fn(async () => { throw new LiveStakesError("riding"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("idle");
    expect(s.status().error).toBeNull();
  });

  it("a caller-observed drained balance re-arms the refill past the stale ready cache", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    let onChain = STAKE * 5n;
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(onChain)),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);                 // ready on a full buffer
    expect(s.status().state).toBe("ready");
    // Bets drain the seat on-chain; the controller's cache still says covered. The book
    // source reads the live balance every poll and passes it through. run() re-reads and is
    // authoritative — the hint only INVALIDATES the stale cache, it is never trusted as
    // truth (trusting it would rebuild a healthy seat on one stale observation).
    onChain = 0n;
    now.mockReturnValue(1_000_000 + 6_000);   // past RETRY_GAP_MS
    await s.ensureNow(STAKE, 0n);
    expect(client.cashOut).toHaveBeenCalledTimes(1); // the silent rebuild actually fired
    now.mockRestore();
  });

  it("does not rebuild a healthy seat on a stale low observation", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      const client = fakeClient({
        delegationState: vi.fn(async () => "reuse" as const),
        bettorSnapshot: vi.fn(async () => bettorSnap(STAKE * 5n)),
      });
      const s = createPaddockStaging({ client });
      await s.ensureNow(STAKE);
      now.mockReturnValue(1_000_000 + 6_000);
      await s.ensureNow(STAKE, 0n);            // stale caller observation; chain is healthy
      expect(client.cashOut).not.toHaveBeenCalled();
      expect(s.status().state).toBe("ready");
    } finally { now.mockRestore(); }
  });

  it("money already on the L1 ledger counts — no fresh SOL demanded to delegate it", async () => {
    const client = fakeClient({
      bettorL1Balance: vi.fn(async () => STAKE * 5n),
      walletFunds: vi.fn(async () => ({ sol: FEE_FLOOR_LAMPORTS, stake: 0n })),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("ready");
    expect(client.ensureBettor).toHaveBeenCalledTimes(1);
    expect(client.ensureBettor.mock.calls[0][0]).toBe(STAKE * 5n); // target = what's already there
  });

  it("a wallet-read blip on the fresh path retries quietly", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => { throw new Error("503"); }) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("idle");
    expect(s.status().error).toBeNull();
    expect(client.ensureBettor).not.toHaveBeenCalled();
  });

  it("a failed race read on a live seat retries quietly — never a rebuild", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n)),
      raceSnapshot: vi.fn(async () => { throw new Error("502"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(client.cashOut).not.toHaveBeenCalled();
    expect(s.status().state).toBe("idle");
  });

  it("a generic cashOut failure surfaces as an error state", async () => {
    const client = fakeClient({
      delegationState: vi.fn(async () => "reuse" as const),
      bettorSnapshot: vi.fn(async () => bettorSnap(0n)),
      cashOut: vi.fn(async () => { throw new Error("tx failed hard"); }),
    });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("error");
    expect(s.status().error).toMatch(/tx failed hard/);
  });

  it("an ensureBettor failure surfaces as an error state", async () => {
    const client = fakeClient({ ensureBettor: vi.fn(async () => { throw new Error("delegate timed out"); }) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    expect(s.status().state).toBe("error");
    expect(s.status().error).toMatch(/delegate timed out/);
  });

  it("dispose makes ensure a no-op and mutes status writes", async () => {
    const changes: number[] = [];
    const client = fakeClient();
    const s = createPaddockStaging({ client, onChange: () => changes.push(1) });
    s.dispose();
    await s.ensureNow(STAKE);
    expect(client.delegationState).not.toHaveBeenCalled();
    expect(changes.length).toBe(0);
  });

  it("throttles repeat attempts (min interval) so a frame-loop trigger cannot hammer RPC", async () => {
    const client = fakeClient({ walletFunds: vi.fn(async () => ({ sol: 0n, stake: 0n })) });
    const s = createPaddockStaging({ client });
    await s.ensureNow(STAKE);
    await s.ensureNow(STAKE); // immediately again
    expect(client.delegationState).toHaveBeenCalledTimes(1);
  });
});
