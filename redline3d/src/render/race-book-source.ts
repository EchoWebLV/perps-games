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
  GRID, PHASE_MARKET, PHASE_RACING, PHASE_SETTLED, SCALE, payoutOf, settlePool,
  type BettorSnap, type PaddockBook, type RaceSnap,
} from "../chain/paddock";
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
  /** The player's spendable balance. */
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
 *  makes slot/car confusion invisible in local tests while it silently pays the wrong car on-chain. */
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

/** Exactly the slice of `PaddockBook` a book source touches: read the race, read my ticket, send a
 *  bet. Onboarding (`ensureBettor`), delegation state and `claim` belong to the wallet flow, not to
 *  the thing that paints a market — narrowing here says so in the type, and keeps this module from
 *  quietly growing a dependency on the rest of the client. */
export type PaddockBookReader = Pick<PaddockBook, "raceSnapshot" | "bettorSnapshot" | "placeBet">;

export interface ChainBookOptions {
  /** Seconds between ER reads. Default `POLL_SECS`. */
  pollSecs?: number;
  /** Anything that went wrong off the frame path (a failed bet, a dropped snapshot fetch). Default
   *  `console.warn` — the book has no UI of its own and swallowing these silently is worse. */
  onError?: (where: string, e: unknown) => void;
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

  let race: RaceSnap | null = null;
  let bettor: BettorSnap | null = null;
  let lockedMult: number[] = [];   // CAR-indexed, frozen at lock()
  let settled: BookSettle | null = null;
  let pending: number | null = null; // CAR id of a bet in flight
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
      bettor = b;
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

    wallet: () => (bettor ? baseToUnits(bettor.balance) : 0),

    /** Null until the crank locks the market. `Race.order` is ZEROED on every roll into MARKET, so a
     *  market-phase read would hand back a perfectly well-formed `[0,0,0,0,0,0,0,0]` — an "order" that
     *  is really the absence of one. Returning it would pace the whole field onto car 0 and then swap
     *  the result out from under the render at the lock. Phase is the only honest gate. */
    finishOrder() {
      const r = race; // bound so the null-narrowing survives into the mapping closure
      if (!r || r.phase === PHASE_MARKET) return null;
      return r.order.map((slot) => r.entrants[slot]);
    },

    /** `carId` is a roster index; the chain wants the SLOT that car is starting from. */
    placeBet(carId, amount) {
      if (!race || race.phase !== PHASE_MARKET) return; // the market is shut; the program would reject it
      if (pending !== null) return;                     // one bet in flight at a time (the panel greys the rest)
      const slot = race.entrants.indexOf(carId);
      if (slot < 0) return;
      pending = carId;
      client
        .placeBet(slot, BigInt(unitsToBase(amount)))
        .then(() => refresh())          // pull the landed pools/stakes back before the button frees up
        .catch((e) => report("placeBet", e))
        .finally(() => { pending = null; });
    },
    pendingBet: () => pending,

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
        // The LIVE on-chain balance, not balance+payout: the vault credits a win on `claim` (or on the
        // next bet's auto-settle), so quoting a balance the chain has not written would be inventing
        // money. `net` is what the race made; this is what is actually in the account right now.
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
