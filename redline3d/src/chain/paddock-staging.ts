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
  /** Fire-and-forget trigger. Cheap when already ready/inflight/throttled. The caller that
   *  polls the chain anyway (the book source) passes what it just read as
   *  `observedBetableBase` — the controller's own cache only updates when a staging run
   *  executes, so without the observation a drained balance would short-circuit "ready"
   *  forever and the silent refill would never fire. */
  ensure(stakeBase: bigint, observedBetableBase?: bigint): void;
  /** Awaitable variant — main.ts entry kick and tests. Never rejects; failures land in status(). */
  ensureNow(stakeBase: bigint, observedBetableBase?: bigint): Promise<void>;
  dispose(): void;
}

type StagingClient = Pick<PaddockBook,
  "delegationState" | "bettorSnapshot" | "raceSnapshot" | "walletFunds" | "bettorL1Balance" | "ensureBettor" | "cashOut">;

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
    if (disposed) return;
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

    if (state !== "fresh") {
      if (state === "reuse") {
        const [race, bettor] = await Promise.all([
          client.raceSnapshot().catch(() => null),
          client.bettorSnapshot().catch(() => null),
        ]);
        // On "reuse" the pair provably exists on L1, so a null bettor snapshot is always a
        // failed ER read, never a broke player — rebuilding on it would spend the ~2-cycle
        // money round trip over one bad RPC response. Quietly retry instead. And on reuse the
        // Race singleton provably exists too — a null race would silently drop the claimable
        // term and rebuild a seat whose win covers the stake.
        if (!bettor || !race) { set({ state: "idle", step: null, error: null }); return; }
        betable = betableOf(race, bettor);
        if (betable >= stakeBase) {
          // The seat covers the bet — but the "one number" the panel shows still needs the
          // wallet half, and a returning player never walks the fresh path that reads it.
          walletSol = (await client.walletFunds().catch(() => ({ sol: walletSol, stake: 0n }))).sol;
          set({ state: "ready", step: null, error: null });
          return;
        }
      }
      // Short (reuse) or torn (busy): the silent rebuild — cashOut claims any past win,
      // exits, polls the undelegation home, withdraws + unwraps, so the fresh path below
      // re-stages from the wallet. Busy comes down the same path because exit is the only
      // instruction that reunites a torn pair (cashOut routes "busy" down it deliberately).
      // Blocked while stakes ride the LIVE race — that is normal play, not news: quiet retry.
      set({ state: "refilling", error: null });
      try {
        await client.cashOut((s) => set({ step: s }));
      } catch (e) {
        if (e instanceof LiveStakesError) { set({ state: "idle", step: null, error: null }); return; }
        throw e;
      }
    }

    // Fresh (or just-rebuilt): mirror game-session's ensureSession — read what the L1 ledger
    // already holds FIRST, so a deposit that landed ahead of a failed delegation is delegated
    // for free instead of wedging every retry on "needs SOL" while the money sits one account
    // over. Read blips retry quietly (the module's contract: error only when the player must act).
    const have = await client.bettorL1Balance().catch(() => null);
    if (have === null) { set({ state: "idle", step: null, error: null }); return; }
    const funds = await client.walletFunds().catch(() => null);
    if (funds === null) { set({ state: "idle", step: null, error: null }); return; }
    walletSol = funds.sol;
    // A stranded wrap (deposit failed after its wrap landed) leaves spendable wSOL in the ATA;
    // ensureBettor nets it before wrapping, so it counts toward affordability here.
    const spendable = (funds.sol > FEE_FLOOR_LAMPORTS ? funds.sol - FEE_FLOOR_LAMPORTS : 0n) + funds.stake;
    if (funds.sol < FEE_FLOOR_LAMPORTS || have + spendable < stakeBase) {
      set({ state: "error", step: null, error: "Your wallet needs SOL first — open the wallet panel and send SOL to your address." });
      return;
    }
    // Target balance for ensureBettor (its `amount` is a target, not a delta): a buffer of
    // bets, capped by what ledger + wallet can reach, never below what the ledger already
    // holds — "top up", never "ignore what's there".
    const want = stakeBase * BigInt(STAKE_BUFFER_BETS);
    const cap = have + spendable;
    let target = want > cap ? cap : want;
    if (target < have) target = have;
    set({ state: stat.state === "refilling" ? "refilling" : "staging", error: null, step: null });
    await client.ensureBettor(target, (s) => set({ step: s }));
    await readBetable();
    if (betable < target) betable = target; // the ER clone can lag right after delegation (game-session live-hit)
    walletSol = (await client.walletFunds().catch(() => ({ sol: walletSol, stake: 0n }))).sol;
    set({ state: "ready", step: null, error: null });
  }

  async function ensureNow(stakeBase: bigint, observedBetableBase?: bigint): Promise<void> {
    if (disposed) return;
    if (observedBetableBase !== undefined) betable = observedBetableBase;
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
    ensure: (stakeBase, observedBetableBase) => { void ensureNow(stakeBase, observedBetableBase); },
    ensureNow,
    dispose() { disposed = true; },
  };
}
