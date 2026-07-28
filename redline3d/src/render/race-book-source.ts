// The seam between the race SHOW and the money behind it. `race-mode.ts` renders eight cars around a
// circuit and paints a pari-mutuel market beside them; it must not care whether the pools, the wallet
// and the winner came from a browser sim or from an on-chain book in the ER. Everything money-shaped
// and everything result-shaped now arrives through ONE interface, so the local sim and (next) the
// paddock client are two implementations of the same contract and race-mode never branches on which
// one it holds.
//
// The division of labour this encodes: the BOOK owns the RESULT and the MONEY; the HOST owns the SHOW.
// race-mode still decides how a winner is dramatised (surges, camera cuts, finish times) — it just no
// longer decides *who* wins, because a chain book decided that before the lights went out.
//
// ⚠️ SLOT ≠ CAR — the one rule this interface exists to enforce.
// The paddock crank PERMUTES the grid on every race roll (verified live on the wSOL book,
// 2026-07-27): on-chain `pools[i]`, `stakes[i]`, `order[]` and `place_bet(car_id)` are all indexed by
// starting SLOT, and `entrants[slot]` names the car standing in it. Slot 0 is not car 0 after race 0.
// Get that wrong and the panel shows the right odds under the wrong name and pays the wrong car — and
// it looks entirely plausible on screen, which is what makes it dangerous.
//
// So this interface refuses to traffic in slots at all. EVERY array crossing it is CAR-indexed (index
// = position in race-mode's roster / `DEFAULT_GRID`) and every id crossing it — `placeBet(carId)`,
// `settle(winnerId)`, `finishOrder()` — is a CAR id. Each implementation resolves its own slot
// mapping internally, so a consumer physically cannot forget to translate. `entrants()` exposes the
// mapping itself, not because callers need it to read the arrays, but so the permutation is a stated
// fact of the contract and raw on-chain state can still be reconciled against what is on screen.
import { RAKE } from "../core/race-payout";
import {
  GRID, HISTORY_LEN, PHASE_MARKET, PHASE_RACING, PHASE_SETTLED, SCALE,
  findResult, payoutOf, settlePool, settleTicket,
  type BettorSnap, type OnboardStep, type PaddockBook, type RaceSnap,
} from "../chain/paddock";
import { betableOf, type PaddockStaging, type StageStep } from "../chain/paddock-staging";
import { baseToUnits, unitsToBase } from "../core/stake-currency";

/** The market's own phase — deliberately the same three states the program's `Race.phase` uses
 *  (0 market / 1 racing / 2 finish), NOT the host's five-state render phase. A book has no opinion
 *  about COUNTDOWN; that is theatre. */
export type BookPhase = "MARKET" | "RACING" | "FINISH";

/** What a settled market paid the player. `net` is stake-relative (gross minus everything staked this
 *  race), which is the number the FINISH card shows. */
export interface BookSettle {
  winnerId: number;
  net: number;
  winnerMult: number;
  walletAfter: number;
}

/** The chain plumbing running behind the scenes, expressed as progress. Two kinds:
 *  "setup" — the one-time seat build on first arrival; "refill" — the background top-up
 *  after the balance ran short. Either way the player's only verb is BET; this is the line
 *  that explains why BET is briefly unavailable, never a flow they drive. */
export interface BookOnboarding {
  kind: "setup" | "refill";
  /** True while the controller is actively moving the seat (state staging/refilling) — even
   *  between steps. The BET gate keys on THIS, not on `step`: the stepless instants inside a
   *  run are exactly when a send would hit a torn pair. */
  working: boolean;
  /** The step running right now, or null when nothing is in flight (idle, finished, or on one of the
   *  `done`/`ready` transitions the mapper collapses). */
  step: StageStep | null;
  /** 1-based position of `step` in the kind's own sequence; 0 when between steps. The controller emits
   *  only the steps it actually RUNS — a returning wallet skips most of them, a non-wSOL mint never
   *  wraps — so this is a position in a fixed sequence, not a count of steps taken, and it can jump. */
  index: number;
  /** `ONBOARD_STEPS.length` or `REFILL_STEPS.length`, whichever kind this is. */
  of: number;
  /** The STAGING pipeline's own error — actionable, and about the seat: "your wallet needs SOL".
   *  Never a bet failure. */
  error: string | null;
  /** A failed BET send (market closed, not enough balance) — transient, its own note in the panel,
   *  never allowed to mask refill progress. Kept apart from `error` because the two have different
   *  causes, different lifetimes and different things to do about them; folding them into one field
   *  means a tap that failed BECAUSE a refill was mid-flight hides the refill explaining it. */
  betError: string | null;
}

/** The onboarding sequence, in the order `ensureBettor` runs it. `ready` is deliberately absent: it
 *  is the end of the work, not a piece of it, and is reported at the end of the bar. */
export const ONBOARD_STEPS: readonly OnboardStep[] = ["join", "wrap", "deposit", "delegate", "confirm"];

/** The refill path, in the order `cashOut` + `ensureBettor` actually run it: the whole way out
 *  (claim → exit → undelegate → withdraw → unwrap), then the buffer back in (wrap → deposit →
 *  delegate → confirm). `done`/`ready` are transitions, not work — the mapper collapses them
 *  to a stepless beat rather than letting `indexOf(-1)` yank the bar backwards. `join` is absent
 *  for the same reason `ready` is absent above: the account already exists by the time a refill runs. */
export const REFILL_STEPS: readonly StageStep[] = ["claim", "exit", "undelegate", "withdraw", "unwrap", "wrap", "deposit", "delegate", "confirm"];

/** An older ticket the player is still holding, and how much of the claim window is left on it.
 *
 *  The program keeps results in a `HISTORY_LEN`-slot ring keyed by `seq % HISTORY_LEN`
 *  (`Race::find_result`, state.rs), so race N's result is overwritten when race N+32 settles. What
 *  happens past that edge is the reason this exists: `claim` does NOT fail on an aged-out ticket —
 *  `settle_ticket` finds no result, credits zero, and `claim` then zeroes the stakes and resets the
 *  ticket anyway (lib.rs). `place_bet`'s auto-settle does exactly the same on the player's next bet.
 *  So the money does not bounce off an error the UI could catch; it silently stops existing. */
export interface BookClaim {
  /** Sequence number of the race the ticket is holding — a race counter, nowhere near 2^53. */
  raceSeq: number;
  /** What the ring says is owed, in display units. Zero when the result has aged out: the entry that
   *  said what the ticket was worth is the thing that is gone. */
  amount: number;
  /** Races that can still settle before this ticket's ring slot is overwritten; 0 once it has been. */
  racesLeft: number;
  /** `HISTORY_LEN` — the length of the whole window, so nothing downstream re-hardcodes 32. */
  windowRaces: number;
  /** The result is no longer in the ring. Nothing can pay this ticket, by any instruction. */
  expired: boolean;
}

/** Everything a book needs when a fresh market opens. */
export interface BookOpenCtx {
  seed: number;                 // this race's outcome seed
  strengths: number[];          // CAR-indexed grid strength (roster order — permute it yourself if
                                // you need slot order; see the SLOT ≠ CAR note at the top)
  /** The race's OWN seeded stream, already positioned where the finish-order draw has always sat.
   *  A local book draws its noise off this stream rather than a private one so that every pacing draw
   *  race-mode makes afterwards (T jitter, surge jitter) lands on exactly the sequence position it
   *  always had — the result may now come from outside, but the show must not move. A chain book
   *  ignores it: its order was decided on-chain long before the browser asked. */
  rng: () => number;
}

export interface RaceBookSource {
  /** A new market opens on `seed`. */
  openMarket(ctx: BookOpenCtx): void;
  /** Called once per sim step, in every phase. Local: the fake-bettor inflow. Chain: refresh the ER
   *  snapshot. Being called in every phase (not just MARKET) is what lets a chain book notice the
   *  race locking and settling without race-mode having to know when to look. */
  poll(dt: number): void;
  /** The book's own phase, or null when it has none to report and the host's phase machine rules.
   *  The local sim returns null: it is *told* when to lock by race-mode, so echoing that back as a
   *  phase would be circular. A chain book returns the phase it read off `Race`. */
  phase(): BookPhase | null;
  /** Seconds left in `phase()`, or null when the source has no clock of its own (the local sim: MARKET
   *  length is race-mode's `MARKET_TIME`). A chain book counts down to `phaseEndsTs` so the rendered
   *  clock cannot drift from the chain's. */
  secondsLeft(): number | null;
  /** Which CAR is standing in each starting SLOT: `entrants()[slot]` is a roster index. The identity
   *  map for the local sim; the crank's permutation for a chain book. Nothing else on this interface
   *  needs it — every other array here is already resolved through it — but it is exposed so the
   *  permutation is a stated fact and on-chain state can be reconciled against the screen. */
  entrants(): number[];
  /** Per-CAR pool (roster order), already resolved out of slot order. */
  pools(): number[];
  /** Sum of `pools()`. */
  total(): number;
  /** Payout multiplier per CAR — live while the market is open, FROZEN from `lock()` onward. */
  multipliers(): number[];
  /** The player's own stake per CAR. */
  myStakes(): number[];
  /** The ONE number the player thinks of as "my money". The local sim has only one; a chain book
   *  folds the delegated balance, an uncollected win and the L1 SOL still in the wallet into it.
   *  `betable()` is the narrower number a SINGLE bet can spend, and is what gates BET. */
  wallet(): number;
  /** Winner-first CAR indices (NOT slots), or null while the result is undecided (a chain market that
   *  has not locked yet). */
  finishOrder(): number[] | null;
  /** INTENT, not a mutation. `carId` is a roster index — the book maps it to whatever slot that car
   *  is starting from. The book decides whether the bet lands and when; callers watch `pendingBet()` /
   *  `pools()` to find out. */
  placeBet(carId: number, amount: number): void;
  /** CAR id of a bet still in flight, else null. Always null for the local sim (a browser mutation is
   *  instant); a chain book holds it from send until the ER confirms. */
  pendingBet(): number | null;
  /** The market closes. Multipliers freeze here. */
  lock(): void;
  /** Pay out against `winnerId` (a CAR id) and return what the player made. */
  settle(winnerId: number): BookSettle;
  /** Non-bet winnings (the owner-podium slice of the rake) credited to the wallet, with the line to
   *  show for it. */
  credit(amount: number, label: string): void;
  /** The last `settle()` result, or null before one. */
  lastSettle(): BookSettle | null;
  /** The last `credit()` line, or null. Cleared on the next `openMarket()`. */
  creditNote(): string | null;
  /** Optional: the chain plumbing running behind the scenes right now, as progress to show.
   *
   *  OMITTED ENTIRELY by a book with no plumbing — the local sim, whose wallet is a variable in this
   *  file. Returns null when there is genuinely nothing to say: no staging wired (a read-only chain
   *  book), or staging that is idle/ready and untroubled. Non-null is the line explaining why BET is
   *  briefly unavailable — never a flow the player drives. */
  onboarding?(): BookOnboarding | null;
  /** Optional: spendable in ONE bet right now (delegated balance + auto-settleable past win), display
   *  units. Absent → `wallet()` is the gate, exactly the pre-chain behavior. */
  betable?(): number;
  /** Optional: tell the book what stake the player has selected so it can stage/refill AHEAD of the
   *  tap. The call is cheap every frame; the staging controller throttles itself. The consequence —
   *  at most once per retry gap — can be a multi-race-cycle refill round trip, which is exactly the
   *  point: it happens in the background, ahead of the tap that would otherwise wait for it. */
  ensureFunded?(stakeUnits: number): void;
  /** Optional: an older ticket still holding money, and how much of the claim window is left on it.
   *  Null when there is nothing to say; omitted by a book with no claim window (the local sim settles
   *  in the browser, on the spot). */
  claimWindow?(): BookClaim | null;
  /** Optional: release whatever the book holds (a chain book's poll timer). race-mode only calls this
   *  on a book it created ITSELF — a host that constructs its own book owns that book's lifetime. */
  dispose?(): void;
}

/** seeded PRNG (was duplicated in race-mode.ts and bet-panel.ts; this is now the only copy, and
 *  race-mode re-exports it so `main.ts`'s import keeps working). Identical algorithm — the same seed
 *  must still give the same sequence or every race in the game reshuffles. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the local sim ────────────────────────────────────────────────────────────────────────────────
const FLOW_INTERVAL = 0.8;    // seconds between fake-bettor pool inflows (was bet-panel.ts:41)
const OUTCOME_NOISE = 2.8;    // additive seeded spread — big enough that a common can upset a legendary
const START_WALLET = 100.0;

// MODULE-level, exactly where bet-panel.ts held it: the demo wallet survives RACE AGAIN *and* leaving
// and re-entering the race, and resets only on a page reload. Per-instance state would silently refill
// it every time the player walked back into the grand prix, which is a different game.
let localWallet = START_WALLET;

/** Today's browser-only book, lifted verbatim out of bet-panel.ts + race-mode.ts: pools seeded by
 *  rarity, fake bettors flowing in while the market is open, a wallet the player spends from, and a
 *  finish order drawn from grid strength plus seeded noise. No chain, no server — the demo economy.
 *
 *  Its slot→car map is the IDENTITY: nothing here shuffles the grid, so car `i` starts from slot `i`.
 *  That is stated through `entrants()` rather than assumed, because the identity map is exactly what
 *  makes slot/car confusion invisible in local tests while it silently pays the wrong car on-chain.
 *
 *  `onboarding()` and `claimWindow()` are OMITTED, not stubbed: there is no account to open here and
 *  nothing to claim later — this book settles in the browser, on the spot. */
export function localBookSource(): RaceBookSource {
  let grid: number[] = [];       // entrants(): slot → car. Identity here; permuted on-chain.
  let pools: number[] = [];
  let stakes: number[] = [];
  let lockedMult: number[] = [];
  let locked = false;
  let rng = mulberry32(1);
  let flowAcc = 0;
  let order: number[] | null = null;
  let settled: BookSettle | null = null;
  let credited: string | null = null;

  const total = () => pools.reduce((a, b) => a + b, 0);
  const liveMults = () => { const T = total(); return pools.map((p) => (p > 0 ? (T * (1 - RAKE)) / p : 0)); };

  return {
    openMarket({ seed, strengths, rng: raceRng }) {
      // THE RESULT FIRST, off the race's stream: hidden seeded score = strength + noise, sorted desc.
      // One draw per car, in roster order — the exact position race-mode's scoring loop occupied, so
      // the T-jitter and surge-jitter draws it makes next are unchanged.
      const scored = strengths.map((s, i) => ({ i, score: s + raceRng() * OUTCOME_NOISE }));
      scored.sort((a, b) => b.score - a.score);
      order = scored.map((s) => s.i);
      // THE MARKET SECOND, off a stream of our own seeded identically (as bet-panel.ts always did):
      // pools by rarity strength^1.6 → favourite ~28-32%, longest shot ~4-6% across 8 outcomes.
      rng = mulberry32(seed);
      pools = strengths.map((s) => Math.pow(s, 1.6) * 18 + rng() * 8);
      stakes = strengths.map(() => 0);
      grid = strengths.map((_s, i) => i); // identity: this sim never shuffles the starting grid
      lockedMult = [];
      locked = false;
      flowAcc = 0;
      settled = null;
      credited = null;
    },
    poll(dt) {
      if (locked || pools.length === 0) return; // locked odds are frozen; an unopened market has nothing to flow into
      flowAcc += dt;
      while (flowAcc >= FLOW_INTERVAL) {
        flowAcc -= FLOW_INTERVAL;
        // fake bettor: pick a car weighted toward current favorites, add a stake
        const T = total() || 1;
        let r = rng();
        let pick = 0;
        for (let i = 0; i < pools.length; i++) { r -= pools[i] / T; if (r <= 0) { pick = i; break; } }
        pools[pick] += 5 + rng() * 32;
      }
    },
    phase: () => null,        // no opinion — race-mode's MARKET_TIME phase machine rules the local sim
    secondsLeft: () => null,  // ditto: no clock of its own
    entrants: () => grid,
    pools: () => pools,
    total,
    multipliers: () => (lockedMult.length ? lockedMult : liveMults()),
    myStakes: () => stakes,
    wallet: () => localWallet,
    finishOrder: () => order,
    placeBet(carId, amount) {
      if (locked || localWallet < amount) return;
      localWallet -= amount;
      pools[carId] += amount;
      stakes[carId] += amount;
    },
    pendingBet: () => null,   // a browser mutation is instant; nothing is ever in flight
    lock() {
      locked = true;
      lockedMult = liveMults();
    },
    settle(winnerId) {
      const mult = (lockedMult.length ? lockedMult : liveMults())[winnerId] || 0;
      const staked = stakes.reduce((a, b) => a + b, 0);
      const gross = stakes[winnerId] * mult;
      localWallet += gross;
      settled = { winnerId, net: gross - staked, winnerMult: mult, walletAfter: localWallet };
      return settled;
    },
    credit(amount, label) {
      if (!(amount > 0)) return;
      localWallet += amount;
      credited = `${label}: +$${amount.toFixed(2)}`; // painted alongside the settle result in FINISH
    },
    lastSettle: () => settled,
    creditNote: () => credited,
  };
}

// ── the on-chain book ────────────────────────────────────────────────────────────────────────────
/** Phase-window lengths, in seconds, from the program's own constants
 *  (`onchain/raider/programs/paddock/src/state.rs` — MARKET_SECS / RACE_SECS / FINISH_SECS).
 *  They are re-declared here rather than imported because `chain/paddock.ts` does not export them,
 *  and a silent divergence would desync every rendered clock — so `race-book-source.test.ts` reads
 *  state.rs and asserts these three numbers still match it, the same cross-source guard `idl.test.ts`
 *  uses for the program id. */
export const CHAIN_PHASE_SECS: Record<BookPhase, number> = { MARKET: 15, RACING: 40, FINISH: 6 };

/** How often `poll()` kicks a fresh ER read. The crank runs at ~1s, so a faster poll would only
 *  re-read the same account: `secondsLeft()` is derived from the snapshot's `phaseEndsTs` and stays
 *  continuous between polls, which is precisely why the rendered clock does not need a fast poll. */
const POLL_SECS = 1.0;

const ZERO_GRID = () => new Array<number>(GRID).fill(0);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Exactly the slice of `PaddockBook` a book source touches: read the race, read my ticket, send a
 *  bet. Delegation state and `claim` belong to the wallet flow, not to the thing that paints a market
 *  — narrowing here says so in the type, and keeps this module from quietly growing a dependency on
 *  the rest of the client. Building and refilling the seat is NOT part of the bet path — it happens
 *  ahead of the tap, behind `ChainBookOptions.staging` — so none of it widens this type. */
export type PaddockBookReader = Pick<PaddockBook, "raceSnapshot" | "bettorSnapshot" | "placeBet">;

export interface ChainBookOptions {
  /** Seconds between ER reads. Default `POLL_SECS`. */
  pollSecs?: number;
  /** Anything that went wrong off the frame path (a failed bet, a dropped snapshot fetch). Default
   *  `console.warn` — the book has no UI of its own and swallowing these silently is worse. */
  onError?: (where: string, e: unknown) => void;
  /** The staging controller, when the host holds a wallet that can fund a seat. Absent → a
   *  READ-ONLY book: `onboarding()` is null, `betable()` mirrors balance + claimable, and `placeBet`
   *  sends straight to the ER — the dev harness's shape. Present → the book reports staging
   *  progress and `ensureFunded` keeps the seat ahead of the selected stake. The tap itself
   *  NEVER stages: the 15s market does not wait, so a tap that cannot be funded is a
   *  disabled button with an honest line, not a slow flow. */
  staging?: PaddockStaging;
}

/** A `RaceBookSource` backed by the paddock program's shared Race in the ER.
 *
 *  SLOT → CAR happens HERE and only here. `Race.pools`, `Race.order` and `Ticket.stakes` are indexed
 *  by starting SLOT; `Race.entrants[slot]` is the car (a roster index) standing in it, and the crank
 *  permutes the grid on every roll. Everything this returns is already resolved through `entrants`,
 *  so nothing downstream can forget to translate — see the note at the top of this file.
 *
 *  MONEY UNITS: on-chain amounts are base units (wSOL lamports); everything crossing this interface
 *  is DISPLAY units, via the game's existing `stake-currency` convention (100 display units = 1 SOL).
 *  That is the same "$" the panel has always printed, so the bet chips ($1/$5/$20) stay sane bets.
 *
 *  It never writes a number it did not read. There is no local wallet to debit and no optimistic pool
 *  bump: a bet is `pendingBet()` until the ER confirms it and the next snapshot shows it landed. */
export function chainBookSource(
  client: PaddockBookReader,
  opts: ChainBookOptions = {},
): RaceBookSource & { refresh(): Promise<void> } {
  const pollSecs = opts.pollSecs ?? POLL_SECS;
  const report = opts.onError ?? ((where: string, e: unknown) => console.warn(`[chain-book] ${where}:`, e));
  const staging = opts.staging;

  let race: RaceSnap | null = null;
  let bettor: BettorSnap | null = null;
  let lockedMult: number[] = [];   // CAR-indexed, frozen at lock()
  let settled: BookSettle | null = null;
  let pending: number | null = null; // CAR id of a bet in flight
  let betError: string | null = null; // what the last send said (see openMarket for how long it lives)
  let betErrorFresh = false;          // set by the send that raised it; spent by the next market roll
  let lastKind: BookOnboarding["kind"] = "setup"; // which path the staging was last KNOWN to be on
  let lastPoll = 0;                  // WALL-CLOCK ms of the last read (see poll)
  let fetching = false;              // one ER read at a time — a slow RPC must not stack requests
  let disposed = false;

  /** `bySlot[slot]` → `byCar[entrants[slot]]`. The single translation point for the whole book. */
  const toCar = (bySlot: bigint[]): number[] => {
    const out = ZERO_GRID();
    if (!race) return out;
    race.entrants.forEach((car, slot) => { out[car] = baseToUnits(bySlot[slot] ?? 0n); });
    return out;
  };

  /** What the program would pay a unit staked on `slot`, were it to win — `book::settle_pool` exactly,
   *  in the same integer arithmetic, so the odds on screen and the payout in the vault agree to the
   *  unit. A pool of zero yields a multiplier of zero, matching the program's "nobody backed the
   *  winner, the house takes the pool" branch rather than a divide-by-zero infinity. */
  const multOfSlot = (slot: number): number => {
    if (!race) return 0;
    return Number(settlePool(race.total, race.pools[slot] ?? 0n).multFp) / Number(SCALE);
  };
  const liveMults = (): number[] => {
    const out = ZERO_GRID();
    if (!race) return out;
    race.entrants.forEach((car, slot) => { out[car] = multOfSlot(slot); });
    return out;
  };

  /** The player's stakes, but ONLY when the ticket belongs to the race on screen. A ticket carries the
   *  seq of the race its stakes were placed in; the program auto-settles and rewrites it on the next
   *  bet. Reading a previous race's stakes through the CURRENT `entrants` map would be wrong twice
   *  over — the wrong race's money, permuted by the wrong grid — so a stale ticket reads as no bet. */
  const stakesBase = (): bigint[] => {
    if (!race || !bettor || bettor.raceSeq === null || bettor.raceSeq !== race.seq) return [];
    return bettor.stakes;
  };

  async function refresh(): Promise<void> {
    if (fetching || disposed) return;
    fetching = true;
    try {
      const [r, b] = await Promise.all([client.raceSnapshot(), client.bettorSnapshot()]);
      if (disposed) return;
      // A dropped read leaves the LAST snapshot in place rather than blanking the book: `phase()` and
      // `secondsLeft()` keep reporting the last thing the chain actually said, and the host holds at
      // that point instead of advancing the show past a chain it cannot currently see.
      if (r) race = r;
      // Sticky like `race`: once joined, the pair is never closed (no close instruction exists), so a
      // null read is a failed read, not a vanished account — and three player-facing numbers now hang
      // off it. A never-joined wallet stays null from the start, which is the honest value.
      if (b) bettor = b;
    } catch (e) {
      report("snapshot", e);
    } finally {
      fetching = false;
    }
  }

  const source: RaceBookSource & { refresh(): Promise<void> } = {
    refresh,

    /** The chain opened this market long before the browser noticed. Nothing in `ctx` is used: the
     *  seed, the strengths and the outcome all live on-chain, and the race's seeded stream is for a
     *  book that draws its own result — this one only reports the one already drawn. What DOES happen
     *  here is per-race view state clearing, so a new market never paints the last race's odds. */
    openMarket() {
      lockedMult = [];
      settled = null;
      // A failed send's message gets ONE full market of visibility, not zero. The commonest failure
      // is MarketClosedError, which arrives within a second of the very roll that would otherwise
      // clear it — so clearing on the first roll means the player never reads the sentence explaining
      // why their tap did nothing. The second roll takes it, so it can never become furniture.
      // (A fresh tap clears it immediately; see placeBet.) Staging progress is deliberately not
      // touched here: it is read live off the controller every frame, so a rebuild that outlives a
      // 15s market cannot be blanked by the roll.
      if (betErrorFresh) betErrorFresh = false;
      else betError = null;
    },

    /** Deliberately ignores `dt` and reads the WALL clock. `dt` is the host's sim step — clamped
     *  (race-preview clamps to 0.1s so a stall cannot teleport the cars) and starved to a trickle
     *  whenever the tab is throttled. The chain does not slow down with the frame rate, and neither
     *  does `secondsLeft()`, which is derived from `Date.now()`; pacing the poll off `dt` too would
     *  leave a throttled tab holding a snapshot minutes old while its own clock said the window had
     *  closed. Observed exactly that in the preview pane at ~1.5fps, 2026-07-27. */
    poll() {
      const now = Date.now();
      if (now - lastPoll < pollSecs * 1000) return;
      lastPoll = now;
      void refresh(); // fire-and-forget: the frame loop must never await an RPC
    },

    phase() {
      if (!race) return null; // no snapshot yet — the host holds wherever it is
      if (race.phase === PHASE_MARKET) return "MARKET";
      if (race.phase === PHASE_RACING) return "RACING";
      if (race.phase === PHASE_SETTLED) return "FINISH";
      return null;
    },

    /** Counted down to the snapshot's `phaseEndsTs`, so the number on screen is the chain's clock and
     *  not one this module started. Clamped into the phase's own window: a browser clock that is off
     *  can then cost at most the current window (the render holds at a boundary, or starts one at its
     *  beginning) instead of driving the show to a time the chain has never been at. */
    secondsLeft() {
      const p = source.phase();
      if (!race || p === null) return null;
      const left = race.phaseEndsTs - Date.now() / 1000;
      return Math.max(0, Math.min(CHAIN_PHASE_SECS[p], left));
    },

    entrants: () => (race ? race.entrants.slice() : ZERO_GRID().map((_v, i) => i)),
    pools: () => (race ? toCar(race.pools) : ZERO_GRID()),
    total: () => (race ? baseToUnits(race.total) : 0),
    multipliers: () => (lockedMult.length ? lockedMult : liveMults()),

    myStakes() {
      const base = stakesBase();
      return base.length ? toCar(base) : ZERO_GRID();
    },

    /** ONE number, the way the perps chip shows wallet+play together: the delegated balance,
     *  a past ticket's claimable win, and the L1 SOL still in the wallet. The BET gate is
     *  `betable()`, which is ≤ this — the difference is money that needs a (background) refill
     *  crossing before a bet can spend it. */
    wallet: () => baseToUnits(betableOf(race, bettor))
      + (staging ? baseToUnits(staging.walletSolBase()) : 0),

    /** Null until the crank locks the market. `Race.order` is ZEROED on every roll into MARKET, so a
     *  market-phase read would hand back a perfectly well-formed `[0,0,0,0,0,0,0,0]` — an "order" that
     *  is really the absence of one. Returning it would pace the whole field onto car 0 and then swap
     *  the result out from under the render at the lock. Phase is the only honest gate. */
    finishOrder() {
      const r = race; // bound so the null-narrowing survives into the mapping closure
      if (!r || r.phase === PHASE_MARKET) return null;
      return r.order.map((slot) => r.entrants[slot]);
    },

    /** `carId` is a roster index; the chain wants the SLOT that car is starting from.
     *
     *  ONE send, and nothing else. The seat this spends from was staged before the button was tapped
     *  (`ensureFunded`, off the frame loop) — a 15s market will not wait for a build, so a tap that
     *  cannot be funded has to be a disabled button with an honest line, never a slow flow. */
    placeBet(carId, amount) {
      if (!race || race.phase !== PHASE_MARKET) return; // the market is shut; the program would reject it
      if (pending !== null) return;                     // one bet in flight at a time (the panel greys the rest)
      const slot = race.entrants.indexOf(carId);
      if (slot < 0) return;
      pending = carId;
      betError = null;                                  // a fresh attempt supersedes the last one's message
      betErrorFresh = false;
      const base = BigInt(unitsToBase(amount));
      void (async () => {
        try {
          await client.placeBet(slot, base);
          await refresh();                              // pull the landed pools/stakes back before the button frees up
        } catch (e) {
          report("placeBet", e);
          // The client's own errors are written for a player to read (MarketClosedError,
          // InsufficientBalanceError, BettorTornError in chain/paddock.ts), so the message goes
          // through as it stands rather than being re-worded here.
          betError = messageOf(e);
          betErrorFresh = true;                         // survives the roll that is probably about to happen
        } finally {
          pending = null;
        }
      })();
    },
    pendingBet: () => pending,

    /** Null when this book has no staging behind it (read-only) — the balance on screen is
     *  then the whole story and the panel gates on it exactly as before. */
    onboarding() {
      if (!staging) return null;
      const s = staging.status();
      // A refill that ERRORS must still read as a refill — latch the kind while the state
      // machine is still telling us, so "error" doesn't relabel a ten-minute player as first-time.
      if (s.state === "refilling") lastKind = "refill";
      else if (s.state === "staging") lastKind = "setup";
      const kind = s.state === "error" ? lastKind : s.state === "refilling" ? "refill" : "setup";
      const seq = kind === "refill" ? REFILL_STEPS : ONBOARD_STEPS;
      // The seat is MOVING — which is not the same question as "is a step named right now". The
      // controller enters a state before its first onStep and passes through stepless instants
      // mid-run (walletFunds, delegationState); a send landing in one of those hits a half-moved
      // pair. So this reports the controller's own state, and the BET gate keys on it.
      const working = s.state === "staging" || s.state === "refilling";
      if (s.state === "idle" || s.state === "ready") {
        return s.error || betError ? { kind, working, step: null, index: 0, of: seq.length, error: s.error, betError } : null;
      }
      const step = s.step === "done" || s.step === "ready" ? null : s.step;
      // A step belonging to the OTHER sequence indexes to -1. Reporting it as position 1 would be a
      // confident lie about how far along the bar is; 0 is the same honest "working, position
      // unknown" beat the done/ready transitions get.
      const i = step ? seq.indexOf(step) : -1;
      return { kind, working, step, index: i < 0 ? 0 : i + 1, of: seq.length, error: s.error, betError };
    },

    /** balance + a past ticket's claimable win — what ONE bet can spend right now, because
     *  `place_bet` auto-settles the old ticket before its balance check (proven live). The
     *  math lives in paddock-staging's exported `betableOf`; imported, never re-derived.
     *
     *  EXPOSED ONLY WHEN STAGING IS WIRED: on a read-only book, `betable !== null` would tell the
     *  panel a seat exists behind the number and it would paint top-up copy for a top-up that can
     *  never happen. Absent → the panel gates on `wallet()`, the read-only book's honest whole
     *  story. Same for `ensureFunded`. */
    betable: staging ? () => baseToUnits(betableOf(race, bettor)) : undefined,

    ensureFunded: staging ? (stakeUnits: number) => {
      // Feed the controller what THIS module just read off the chain — its own cache only
      // updates when a staging run executes, so without the observation a drained balance
      // would short-circuit "ready" forever and the silent refill would never fire.
      const observed = race && bettor ? betableOf(race, bettor) : undefined;
      staging.ensure(BigInt(unitsToBase(stakeUnits)), observed);
    } : undefined,

    /** An older ticket still holding money, and what is left of its claim window.
     *
     *  Read off the two snapshots the book already holds, through the client's own `findResult` /
     *  `settleTicket` mirrors rather than re-deriving the ring arithmetic here. `findResult` is the
     *  evidence that decides `expired`: the slot either still carries this ticket's seq or it does
     *  not. `racesLeft` is only for the warning, and says how many further races can settle before
     *  race N+`HISTORY_LEN` overwrites slot N — the crank pushes a result at the RACING→SETTLED edge
     *  and bumps `seq` at the SETTLED→MARKET edge (lib.rs `race_crank`), so the slot survives every
     *  seq up to and including N+31.
     *
     *  Null when there is nothing worth saying: no ticket, a ticket for the race on screen (it has
     *  not been decided yet), or a settled ticket that backed a loser. */
    claimWindow() {
      if (!race || !bettor || bettor.raceSeq === null) return null;
      const seq = bettor.raceSeq;
      if (seq === race.seq) return null;
      const staked = bettor.stakes.reduce((a, b) => a + b, 0n);
      const windowRaces = HISTORY_LEN;
      if (!findResult(race.history, seq)) {
        // Aged out. The stakes are still on the ticket — the result that priced them is what is gone,
        // so the amount is unknowable and reported as such rather than guessed at.
        if (staked === 0n) return null;
        return { raceSeq: Number(seq), amount: 0, racesLeft: 0, windowRaces, expired: true };
      }
      const owed = settleTicket(race.history, bettor);
      if (owed === 0n) return null;
      const racesLeft = Math.max(0, windowRaces - Number(race.seq - seq));
      return { raceSeq: Number(seq), amount: baseToUnits(owed), racesLeft, windowRaces, expired: false };
    },

    /** Freeze the odds. The chain froze them at the lock; this only stops the panel re-deriving them
     *  from pools that can no longer move, so the multiplier shown beside the winner is the one the
     *  market closed at. */
    lock() {
      lockedMult = liveMults();
    },

    /** Report what the chain paid — it does not pay anything. The vault moved at the crank, or will
     *  when the player claims; this mirrors `book::settle_pool` / `book::payout_of` on the frozen
     *  pools so the FINISH card can be painted the instant the rendered race crosses the line, which
     *  can be a second or two before the crank writes the result into `Race.history`.
     *
     *  `winnerId` is what the SIM produced. It is cross-checked, not trusted: the returned
     *  `winnerId` is always the chain's, because the chain is what paid. */
    settle(winnerId) {
      if (!race || race.phase === PHASE_MARKET) {
        settled = { winnerId, net: 0, winnerMult: 0, walletAfter: source.wallet() };
        return settled;
      }
      const winnerSlot = race.order[0];
      const winnerCar = race.entrants[winnerSlot];
      if (winnerCar !== winnerId) {
        // The rendered race finished on a different car than the one the chain paid. That is the
        // single worst failure this whole seam exists to prevent, so it is shouted, and the chain's
        // answer is the one that goes on the card.
        console.error(`[chain-book] rendered winner ${winnerId} != chain winner ${winnerCar} (slot ${winnerSlot}) — showing the chain's`);
      }
      const s = settlePool(race.total, race.pools[winnerSlot] ?? 0n);
      const base = stakesBase();
      const gross = base.length ? payoutOf(base[winnerSlot] ?? 0n, s.multFp) : 0n;
      const staked = base.reduce((a, b) => a + b, 0n);
      settled = {
        winnerId: winnerCar,
        net: baseToUnits(gross) - baseToUnits(staked),
        winnerMult: Number(s.multFp) / Number(SCALE),
        // The same ONE number the header shows (balance + claimable + the L1 SOL in the wallet), not
        // that plus this race's payout: the vault credits a win on `claim` (or on the next bet's
        // auto-settle), so quoting money the chain has not written would be inventing it. The ticket
        // being settled here is still the race on screen, so its own win is not in this figure yet —
        // it appears the moment the chain rolls and the claimable term picks it up. `net` is what the
        // race made; this is what the player actually holds right now.
        walletAfter: source.wallet(),
      };
      return settled;
    },

    /** No-op, deliberately. The owner-podium slice of the rake is a demo-economy idea with no
     *  counterpart in the program — there is no instruction that pays a car's owner. Painting a
     *  "+$x" line for money the chain will never move would be a lie on the FINISH card. */
    credit() {},
    creditNote: () => null,

    lastSettle: () => settled,

    dispose() {
      disposed = true; // a snapshot landing after teardown must not write into freed state
    },
  };

  return source;
}

/** The factory a HOST should use: `chainBookSource` plus one awaited read, so race-mode is never
 *  handed a book that has no phase yet. That matters — a book reporting `phase() === null` hands the
 *  phase machine back to the host, which would open a local 15s market over a chain that may be
 *  mid-race. Priming it makes the very first frame already agree with the chain. */
export async function createChainBookSource(
  client: PaddockBookReader,
  opts: ChainBookOptions = {},
): Promise<RaceBookSource & { refresh(): Promise<void> }> {
  const src = chainBookSource(client, opts);
  await src.refresh();
  if (src.phase() === null) throw new Error("paddock: no Race account in the ER for this book mint");
  return src;
}
