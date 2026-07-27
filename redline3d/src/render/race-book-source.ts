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
