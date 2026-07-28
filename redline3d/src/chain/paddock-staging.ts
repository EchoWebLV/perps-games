// paddock-staging.ts — stage the paddock seat AHEAD of the tap, the way raider stages a
// session on GO (game-session.ts ensureSession): the player thinks in "my SOL"; this moves a
// buffer of bets from the wallet into the delegated Bettor, refills silently when it runs
// short, and never exposes a funding concept. The one paddock difference from raider: the
// market will not wait for a slow build the way a perps round does, so this is fired on
// race ENTRY and on balance-short — never from a BET tap.
import {
  LiveStakesError, settleTicket,
  type BettorSnap, type CashOutStep, type OnboardStep, type PaddockBook, type RaceSnap,
} from "./paddock";

/** Buffer, in bets: stage several bets' worth per crossing so the heavy refill round trip
 *  (claim/exit → undelegate → deposit → re-delegate, ~2 race cycles) stays rare. Same
 *  number, same reasoning as game-session's SESSION_BUFFER_BETS. */
export const STAKE_BUFFER_BETS = 5;
/** Fees + ATA-rent headroom left in the wallet (lamports) — game-session's FEE_FLOOR. */
export const FEE_FLOOR_LAMPORTS = 5_000_000n;
/** Quiet-retry spacing. A blocked refill (live stakes) or a failed RPC retries no faster
 *  than this, so the frame-loop trigger costs a timestamp compare, not a request. */
export const RETRY_GAP_MS = 5_000;

export type StageStep = OnboardStep | CashOutStep;

export interface StageStatus {
  /** idle → staging (first build) / refilling (rebuild) → ready; error only for states the
   *  player must act on (an unfunded wallet). A refill blocked by live stakes goes back to
   *  idle and retries — that is normal play, not news. */
  state: "idle" | "staging" | "refilling" | "ready" | "error";
  step: StageStep | null;
  error: string | null;
}

export interface PaddockStaging {
  status(): StageStatus;
  /** Last-known spendable-in-one-bet base units: delegated balance + a past ticket's
   *  claimable winnings (place_bet auto-settles those before its balance check — proven
   *  live with $3 balance + $4.75 claimable funding a $5 bet, 2026-07-28). */
  betableBase(): bigint;
  /** Last-known L1 native SOL (lamports) — the rest of the "one number" the panel shows. */
  walletSolBase(): bigint;
  /** Fire-and-forget trigger. Cheap when already ready/inflight/throttled. */
  ensure(stakeBase: bigint): void;
  /** Awaitable variant — main.ts entry kick and tests. Never rejects; failures land in status(). */
  ensureNow(stakeBase: bigint): Promise<void>;
  dispose(): void;
}

type StagingClient = Pick<PaddockBook,
  "delegationState" | "bettorSnapshot" | "raceSnapshot" | "walletFunds" | "ensureBettor" | "cashOut">;

const messageOf = (e: unknown): string => String((e as Error)?.message ?? e);

/** balance + claimable-from-a-past-race, off the two snapshots. */
export function betableOf(race: RaceSnap | null, bettor: BettorSnap | null): bigint {
  if (!bettor) return 0n;
  const claimable = race && bettor.raceSeq !== null && bettor.raceSeq !== race.seq
    ? settleTicket(race.history, bettor)
    : 0n;
  return bettor.balance + claimable;
}

export function createPaddockStaging(deps: { client: StagingClient; onChange?: () => void }): PaddockStaging {
  const { client } = deps;
  let stat: StageStatus = { state: "idle", step: null, error: null };
  let betable = 0n;
  let walletSol = 0n;
  let inflight: Promise<void> | null = null;
  let lastAttempt = 0;
  let disposed = false;

  const set = (next: Partial<StageStatus>) => {
    stat = { ...stat, ...next };
    deps.onChange?.();
  };

  async function readBetable(): Promise<bigint> {
    const [race, bettor] = await Promise.all([
      client.raceSnapshot().catch(() => null),
      client.bettorSnapshot().catch(() => null),
    ]);
    betable = betableOf(race, bettor);
    return betable;
  }

  async function run(stakeBase: bigint): Promise<void> {
    const state = await client.delegationState();

    if (state === "reuse") {
      if (await readBetable() >= stakeBase) { set({ state: "ready", step: null, error: null }); return; }
      // Short, and nothing claimable covers it → the silent rebuild: the full way out, then a
      // fresh buffer back in. cashOut claims any past win on the way (classifyExit "claim"),
      // exits, polls the undelegation home, withdraws + unwraps — so ensureBettor below sees a
      // fresh wallet-funded state. Blocked while stakes ride the LIVE race: quietly retry later.
      set({ state: "refilling", error: null });
      try {
        await client.cashOut((s) => set({ step: s }));
      } catch (e) {
        if (e instanceof LiveStakesError) { set({ state: "idle", step: null, error: null }); return; }
        throw e;
      }
    } else if (state === "busy") {
      // Torn pair: exit is the only reuniting instruction, and cashOut routes "busy" down it.
      set({ state: "refilling", error: null });
      await client.cashOut((s) => set({ step: s }));
    }

    // Fresh (or just-rebuilt): fail fast BEFORE spending — sends go out skipPreflight, so a
    // 0-SOL Privy embedded wallet otherwise dies as a silent drop + a long confirm hang.
    const funds = await client.walletFunds();
    walletSol = funds.sol;
    if (funds.sol < stakeBase + FEE_FLOOR_LAMPORTS) {
      set({ state: "error", step: null, error: "Your wallet needs SOL first — open the wallet panel and send SOL to your address." });
      return;
    }
    // Stage a buffer of bets, capped by what the wallet can spare — their money throughout,
    // withdrawable via cash-out. Same sizing as game-session.ensureSession.
    const spendable = funds.sol - FEE_FLOOR_LAMPORTS;
    const want = stakeBase * BigInt(STAKE_BUFFER_BETS);
    const topUp = want > spendable ? spendable : want;
    set({ state: stat.state === "refilling" ? "refilling" : "staging", error: null });
    await client.ensureBettor(topUp, (s) => set({ step: s }));
    await readBetable();
    walletSol = (await client.walletFunds().catch(() => ({ sol: walletSol, stake: 0n }))).sol;
    set({ state: "ready", step: null, error: null });
  }

  async function ensureNow(stakeBase: bigint): Promise<void> {
    if (disposed) return;
    if (inflight) return inflight;
    if (stat.state === "ready" && betable >= stakeBase) return;
    const now = Date.now();
    if (now - lastAttempt < RETRY_GAP_MS) return;
    lastAttempt = now;
    if (stat.state !== "refilling") set({ state: stat.state === "ready" ? "refilling" : "staging", error: null });
    inflight = run(stakeBase)
      .catch((e) => { set({ state: "error", step: null, error: messageOf(e) }); })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    status: () => stat,
    betableBase: () => betable,
    walletSolBase: () => walletSol,
    ensure: (stakeBase) => { void ensureNow(stakeBase); },
    ensureNow,
    dispose() { disposed = true; },
  };
}
