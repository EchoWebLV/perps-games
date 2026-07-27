// The chain-backed book, tested against a fake PaddockBook so the whole slot→car translation, the
// money mirror and the phase clock are exercised without an RPC.
//
// Almost every assertion here is about ONE thing: the crank permutes the grid, so a slot index is not
// a car id, and this file is the only place that translation happens. A test suite that used the
// identity permutation would pass while the real book paid the wrong car — so every fixture below
// uses a grid that is genuinely shuffled.
import { describe, expect, it, vi } from "vitest";
// The program's own source, read as text (the ?raw idiom landing-shell.test.ts uses to assert across
// files, including outside this package). node:fs is not available here — the main vitest config runs
// through vite-plugin-node-polyfills, which stubs it.
import paddockStateRs from "../../../onchain/raider/programs/paddock/src/state.rs?raw";
import paddockLibRs from "../../../onchain/raider/programs/paddock/src/lib.rs?raw";
import { chainBookSource, createChainBookSource, CHAIN_PHASE_SECS, ONBOARD_STEPS, type PaddockBookReader } from "./race-book-source";
import { GRID, HISTORY_LEN, PHASE_MARKET, PHASE_RACING, PHASE_SETTLED, payoutOf, settlePool, TICKET_NO_RACE, type BettorSnap, type OnboardStep, type RaceResultSnap, type RaceSnap } from "../chain/paddock";

// 1 display unit = 1e7 lamports (stake-currency: 9 decimals, 2 display decimals) — so 100 units is
// 1 wSOL, and the panel's $1/$5/$20 chips are 0.01/0.05/0.20 SOL bets.
const UNIT = 10_000_000n;

// A genuinely permuted grid: slot 0 holds car 4, slot 1 holds car 2, … Nothing below is an identity
// map, on purpose.
const ENTRANTS = [4, 2, 5, 6, 0, 1, 7, 3];
const STRENGTHS = [1350, 1800, 1800, 1000, 3200, 2400, 1000, 1800];

function raceSnap(over: Partial<RaceSnap> = {}): RaceSnap {
  return {
    mint: "So11111111111111111111111111111111111111112",
    seq: 18n,
    phase: PHASE_MARKET,
    phaseEndsTs: Math.floor(Date.now() / 1000) + 10,
    entrants: [...ENTRANTS],
    strengths: [...STRENGTHS],
    pools: new Array<bigint>(GRID).fill(0n),
    total: 0n,
    order: new Array<number>(GRID).fill(0),
    seed: new Uint8Array(32),
    feed: "71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr",
    rakeAccrued: 0n,
    history: [],
    ...over,
  };
}

/** A zero-initialised 32-slot ring with `entries` written into their seq-keyed slots — exactly what
 *  `Race::push_result` does. Note slot 0 of an untouched ring reads as a real `{seq: 0}` result: that
 *  is the phantom race 0 the HAZARD note warns about, so nothing below uses seq 0. */
function ring(entries: RaceResultSnap[] = []): RaceResultSnap[] {
  const h: RaceResultSnap[] = Array.from({ length: HISTORY_LEN }, () => ({ seq: 0n, winner: 0, multFp: 0n }));
  for (const e of entries) h[Number(e.seq % BigInt(HISTORY_LEN))] = e;
  return h;
}

/** Ticket stakes: `amount` on one SLOT, nothing anywhere else. */
function stakesOn(slot: number, amount: bigint): bigint[] {
  const s = new Array<bigint>(GRID).fill(0n);
  s[slot] = amount;
  return s;
}

/** Let a fire-and-forget bet path (onboarding → send → refresh) run to completion. */
const settleAsync = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeClient(state: { race: RaceSnap | null; bettor: BettorSnap | null }) {
  const placed: Array<{ slot: number; amount: bigint }> = [];
  const client: PaddockBookReader = {
    async raceSnapshot() { return state.race; },
    async bettorSnapshot() { return state.bettor; },
    async placeBet(carId, amount) { placed.push({ slot: carId, amount: BigInt(amount.toString()) }); },
  };
  return { client, placed };
}

describe("CHAIN_PHASE_SECS", () => {
  // Cross-source guard, the same idiom idl.test.ts uses for the program id: these three numbers are
  // the program's, and the whole chain-driven clock is derived from them. A divergence would not
  // throw anywhere — it would just render every race at the wrong point of its window.
  it("still matches the program's own MARKET_SECS / RACE_SECS / FINISH_SECS", () => {
    const constant = (name: string): number => {
      const m = new RegExp(`pub const ${name}: i64 = (\\d+);`).exec(paddockStateRs);
      if (!m) throw new Error(`${name} not found in state.rs`);
      return Number(m[1]);
    };
    expect(CHAIN_PHASE_SECS.MARKET).toBe(constant("MARKET_SECS"));
    expect(CHAIN_PHASE_SECS.RACING).toBe(constant("RACE_SECS"));
    expect(CHAIN_PHASE_SECS.FINISH).toBe(constant("FINISH_SECS"));
  });
});

describe("chainBookSource", () => {
  it("maps phase codes and counts down to phaseEndsTs, clamped into the phase's own window", async () => {
    const state = { race: raceSnap({ phaseEndsTs: Math.floor(Date.now() / 1000) + 9 }), bettor: null };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    expect(book.phase()).toBe("MARKET");
    expect(book.secondsLeft()!).toBeGreaterThan(7.5);
    expect(book.secondsLeft()!).toBeLessThanOrEqual(9);

    // a phaseEndsTs far in the future (a browser clock hours behind the validator's) can only ever
    // report a whole window, never a time the chain has never been at
    state.race = raceSnap({ phase: PHASE_RACING, phaseEndsTs: Math.floor(Date.now() / 1000) + 100_000 });
    await book.refresh();
    expect(book.phase()).toBe("RACING");
    expect(book.secondsLeft()).toBe(CHAIN_PHASE_SECS.RACING);

    // and one in the past floors at 0 rather than going negative
    state.race = raceSnap({ phase: PHASE_SETTLED, phaseEndsTs: Math.floor(Date.now() / 1000) - 500 });
    await book.refresh();
    expect(book.phase()).toBe("FINISH");
    expect(book.secondsLeft()).toBe(0);
  });

  it("reports no phase at all until the first snapshot lands", () => {
    const { client } = fakeClient({ race: null, bettor: null });
    const book = chainBookSource(client);
    expect(book.phase()).toBeNull();
    expect(book.secondsLeft()).toBeNull();
    expect(book.finishOrder()).toBeNull();
    expect(book.total()).toBe(0);
    expect(book.pools()).toEqual(new Array(GRID).fill(0)); // never undefined → the panel can never render NaN
  });

  it("resolves slot-indexed pools into CAR order through entrants[]", async () => {
    const pools = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n].map((n) => n * UNIT);
    const state = { race: raceSnap({ pools, total: 36n * UNIT }), bettor: null };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    // slot 0 holds car 4 and has 1 unit in it → pools()[4] === 1, NOT pools()[0]
    const byCar = new Array<number>(GRID).fill(0);
    ENTRANTS.forEach((car, slot) => { byCar[car] = slot + 1; });
    expect(book.pools()).toEqual(byCar);
    expect(book.pools()[4]).toBe(1);
    expect(book.total()).toBe(36);
    expect(book.entrants()).toEqual(ENTRANTS);
  });

  it("hides the finish order until the market locks, then reports it as CAR ids", async () => {
    // Race.order is zeroed on every roll into MARKET, so a market read is a well-formed all-zero
    // array. Returning it would pace the whole field onto one car.
    const state = { race: raceSnap({ order: [0, 0, 0, 0, 0, 0, 0, 0] }), bettor: null };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    expect(book.finishOrder()).toBeNull();

    state.race = raceSnap({ phase: PHASE_RACING, order: [3, 1, 7, 2, 5, 4, 6, 0] });
    await book.refresh();
    // order[] holds SLOTS; the book hands back the cars standing in them
    expect(book.finishOrder()).toEqual([3, 1, 7, 2, 5, 4, 6, 0].map((slot) => ENTRANTS[slot]));
    expect(book.finishOrder()![0]).toBe(ENTRANTS[3]); // winner = the car in slot 3, i.e. car 6
  });

  it("multipliers mirror book::settle_pool exactly, and freeze at lock()", async () => {
    const pools = [10n, 30n, 0n, 0n, 60n, 0n, 0n, 0n].map((n) => n * UNIT);
    const total = 100n * UNIT;
    const state = { race: raceSnap({ pools, total }), bettor: null };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    const expected = (slot: number) => Number(settlePool(total, pools[slot]).multFp) / 1e6;
    expect(book.multipliers()[ENTRANTS[0]]).toBeCloseTo(expected(0), 9); // 95/10 = 9.5
    expect(book.multipliers()[ENTRANTS[0]]).toBeCloseTo(9.5, 9);
    expect(book.multipliers()[ENTRANTS[2]]).toBe(0);                     // nobody backed it → the house takes the pool

    book.lock();
    // the pools move on-chain after the freeze (a late bet in the same slot, a different race) —
    // the frozen odds must not follow them
    state.race = raceSnap({ pools: pools.map((p) => p * 2n), total: total * 2n });
    await book.refresh();
    expect(book.multipliers()[ENTRANTS[0]]).toBeCloseTo(9.5, 9);
  });

  it("shows no stake when the ticket belongs to a DIFFERENT race than the one on screen", async () => {
    const stakes = new Array<bigint>(GRID).fill(0n);
    stakes[1] = 5n * UNIT; // 5 units on slot 1 = car 2
    const state = {
      race: raceSnap({ seq: 18n }),
      bettor: { balance: 250n * UNIT, stakes, raceSeq: 18n } as BettorSnap,
    };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    expect(book.myStakes()[2]).toBe(5);   // slot 1 → car 2
    expect(book.myStakes()[1]).toBe(0);
    expect(book.wallet()).toBe(250);

    // the chain rolled on; the ticket still carries the OLD seq, and the grid was permuted with the
    // roll — reading those stakes through the new map would be the wrong money on the wrong car
    state.bettor = { balance: 250n * UNIT, stakes, raceSeq: 17n };
    await book.refresh();
    expect(book.myStakes()).toEqual(new Array(GRID).fill(0));

    // the u64::MAX sentinel ("belongs to no race") arrives as null and reads the same way
    state.bettor = { balance: 250n * UNIT, stakes, raceSeq: null };
    await book.refresh();
    expect(book.myStakes()).toEqual(new Array(GRID).fill(0));
    expect(TICKET_NO_RACE).toBe((1n << 64n) - 1n); // the sentinel the snapshot mapper collapses
  });

  it("places a bet on the SLOT the car is starting from, in base units, one at a time", async () => {
    const state = { race: raceSnap(), bettor: null };
    const { client, placed } = fakeClient(state);
    let resolveBet: () => void = () => {};
    client.placeBet = (slot, amount) => new Promise<void>((res) => {
      placed.push({ slot, amount: BigInt(amount.toString()) });
      resolveBet = res;
    });
    const book = chainBookSource(client);
    await book.refresh();

    book.placeBet(2, 5);                       // car 2 is standing in SLOT 1
    expect(placed).toEqual([{ slot: 1, amount: 5n * UNIT }]);
    expect(book.pendingBet()).toBe(2);         // reported as a CAR id, which is what the panel greys

    book.placeBet(5, 5);                       // a second bet while one is in flight is refused
    expect(placed.length).toBe(1);

    resolveBet();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(book.pendingBet()).toBeNull();
  });

  it("refuses a bet once the chain's market has shut", async () => {
    const state = { race: raceSnap({ phase: PHASE_RACING }), bettor: null };
    const { client, placed } = fakeClient(state);
    const book = chainBookSource(client);
    await book.refresh();
    book.placeBet(2, 5);
    expect(placed).toEqual([]);
    expect(book.pendingBet()).toBeNull();
  });

  it("settles off the chain's winner and mirrors payout_of to the unit", async () => {
    const pools = [10n, 30n, 0n, 0n, 60n, 0n, 0n, 0n].map((n) => n * UNIT);
    const total = 100n * UNIT;
    const stakes = new Array<bigint>(GRID).fill(0n);
    stakes[0] = 4n * UNIT;   // 4 units on slot 0 (car 4) — the winner
    stakes[4] = 6n * UNIT;   // 6 units on slot 4 (car 0) — a loser
    const state = {
      race: raceSnap({ phase: PHASE_RACING, pools, total, order: [0, 4, 1, 2, 3, 5, 6, 7] }),
      bettor: { balance: 90n * UNIT, stakes, raceSeq: 18n } as BettorSnap,
    };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();

    const s = book.settle(ENTRANTS[0]);        // the sim agrees: car 4 won
    const mirror = settlePool(total, pools[0]);
    expect(s.winnerId).toBe(ENTRANTS[0]);      // car 4
    expect(s.winnerMult).toBeCloseTo(Number(mirror.multFp) / 1e6, 9);
    // gross = payout_of(4 units on the winner) ; net is stake-relative (gross − everything staked)
    const gross = Number(payoutOf(stakes[0], mirror.multFp)) / 1e7;
    expect(s.net).toBeCloseTo(gross - 10, 6);
    expect(s.walletAfter).toBe(90);            // the LIVE balance — the vault credits a win on claim
    expect(book.lastSettle()).toBe(s);
  });

  it("shouts and shows the CHAIN's winner when the rendered race disagrees", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = {
      race: raceSnap({ phase: PHASE_RACING, pools: new Array<bigint>(GRID).fill(UNIT), total: 8n * UNIT, order: [3, 1, 7, 2, 5, 4, 6, 0] }),
      bettor: null,
    };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    const s = book.settle(999); // a winner no chain ever produced
    expect(err).toHaveBeenCalled();
    expect(s.winnerId).toBe(ENTRANTS[3]); // the chain's, not the caller's
    err.mockRestore();
  });

  it("never invents an owner-podium credit — there is no such instruction on-chain", async () => {
    const state = { race: raceSnap(), bettor: { balance: 10n * UNIT, stakes: new Array<bigint>(GRID).fill(0n), raceSeq: null } as BettorSnap };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    book.credit(50, "Podium — P1");
    expect(book.creditNote()).toBeNull();
    expect(book.wallet()).toBe(10); // untouched: a book that does not hold the money cannot pay it
  });

  it("keeps the last snapshot when a read drops, rather than blanking the market", async () => {
    const state = { race: raceSnap({ pools: [UNIT, 0n, 0n, 0n, 0n, 0n, 0n, 0n], total: UNIT }), bettor: null };
    const { client } = fakeClient(state);
    const warned: unknown[] = [];
    const book = chainBookSource(client, { onError: (w) => warned.push(w) });
    await book.refresh();
    expect(book.total()).toBe(1);

    client.raceSnapshot = async () => { throw new Error("er down"); };
    const book2 = chainBookSource(client, { onError: (w) => warned.push(w) });
    await book2.refresh();
    expect(warned).toEqual(["snapshot"]);
    expect(book2.phase()).toBeNull(); // never had one → the host holds in LOADING rather than guessing

    await book.refresh();             // the primed book keeps what the chain last said
    expect(warned).toEqual(["snapshot", "snapshot"]);
    expect(book.phase()).toBe("MARKET");
    expect(book.total()).toBe(1);
  });

  it("createChainBookSource refuses to hand back a book with no phase", async () => {
    const { client } = fakeClient({ race: null, bettor: null });
    await expect(createChainBookSource(client)).rejects.toThrow(/no Race account/);
    const live = fakeClient({ race: raceSnap(), bettor: null });
    const ok = await createChainBookSource(live.client);
    expect(ok.phase()).toBe("MARKET"); // primed: the host's very first frame already agrees with the chain
  });

  it("reports no onboarding at all without a wallet behind it — a read-only book cannot open one", async () => {
    const state = { race: raceSnap(), bettor: null };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    expect(book.onboarding!()).toBeNull();
  });

  it("runs the one-time onboarding before the first bet, reporting each step's place in the sequence", async () => {
    const state = { race: raceSnap(), bettor: null };
    const { client, placed } = fakeClient(state);
    const trace: string[] = [];
    const amounts: bigint[] = [];
    // The steps a FIRST-TIME wSOL wallet actually runs. `ensureBettor` emits only what it runs, which
    // is the whole reason `index` is a position in the fixed sequence and not a count of steps taken.
    const steps: OnboardStep[] = ["join", "wrap", "deposit", "delegate", "confirm", "ready"];
    const book = chainBookSource(client, {
      onboard: async (amount, onStep) => {
        amounts.push(amount);
        for (const s of steps) {
          onStep(s);
          const o = book.onboarding!()!;
          trace.push(`${o.step}:${o.index}/${o.of}`);
          await Promise.resolve();
        }
      },
    });
    await book.refresh();
    expect(book.onboarding!()).toEqual({ step: null, index: 0, of: ONBOARD_STEPS.length, error: null });

    book.placeBet(2, 5);                 // car 2 is standing in SLOT 1
    expect(book.pendingBet()).toBe(2);   // the panel's amber "···" holds for the WHOLE sequence
    await settleAsync();

    expect(trace).toEqual(["join:1/5", "wrap:2/5", "deposit:3/5", "delegate:4/5", "confirm:5/5", "ready:5/5"]);
    expect(amounts).toEqual([5n * UNIT]); // the bet's own amount, in base units — the book invents no deposit size
    expect(placed).toEqual([{ slot: 1, amount: 5n * UNIT }]); // and only THEN does the bet go out
    expect(book.pendingBet()).toBeNull();
    expect(book.onboarding!()).toEqual({ step: null, index: 0, of: ONBOARD_STEPS.length, error: null });
  });

  it("a returning wallet skips to the end of the sequence rather than counting from one", async () => {
    // `ensureBettor` returns `ready` immediately when the Bettor/Ticket pair is already delegated.
    // The counter jumping to the end is the honest report of that: no step was needed.
    const state = { race: raceSnap(), bettor: null };
    const { client } = fakeClient(state);
    const book = chainBookSource(client, { onboard: async (_a, onStep) => { onStep("ready"); } });
    await book.refresh();
    book.placeBet(2, 5);
    await settleAsync();
    expect(book.onboarding!()).toEqual({ step: null, index: 0, of: 5, error: null }); // cleared once the bet landed
  });

  it("keeps what stopped the first-bet path on screen, in the client's own words", async () => {
    const state = { race: raceSnap(), bettor: null };
    const { client, placed } = fakeClient(state);
    const warned: string[] = [];
    let onboardingWorks = false;
    const book = chainBookSource(client, {
      onError: (w) => warned.push(w),
      onboard: async (_a, onStep) => {
        onStep("delegate");
        if (!onboardingWorks) throw new Error("delegate_bettor: Bettor/Ticket did not reach owner in time");
        onStep("ready");
      },
    });
    await book.refresh();
    book.placeBet(2, 5);
    await settleAsync();
    expect(placed).toEqual([]);                       // the bet never went out
    expect(book.pendingBet()).toBeNull();             // and the button is free again, not stuck
    expect(warned).toEqual(["placeBet"]);
    expect(book.onboarding!()!.error).toContain("did not reach owner");

    // the SEND failing after a clean onboarding lands on the same line — the send is what it was for
    onboardingWorks = true;
    client.placeBet = async () => { throw new Error("Betting just closed for this race — the next one is seconds away."); };
    book.placeBet(2, 5);
    await settleAsync();
    expect(book.onboarding!()!.error).toContain("Betting just closed");

    // …and the next market clears it, since the chain opens one every MARKET_SECS
    book.openMarket({ seed: 1, strengths: [], rng: () => 0 });
    expect(book.onboarding!()!.error).toBeNull();
  });

  it("never blanks an onboarding that is still running when the chain rolls the market", async () => {
    const state = { race: raceSnap(), bettor: null };
    const { client } = fakeClient(state);
    let held: (() => void) | null = null;
    const book = chainBookSource(client, {
      onboard: (_a, onStep) => new Promise<void>((res) => { onStep("confirm"); held = res; }),
    });
    await book.refresh();
    book.placeBet(2, 5);
    await settleAsync();
    expect(book.onboarding!()!.step).toBe("confirm");
    // the ~25×1s owner poll outlives a 15s market: the chain rolls into the next one mid-onboarding
    book.openMarket({ seed: 1, strengths: [], rng: () => 0 });
    expect(book.onboarding!()!.step).toBe("confirm"); // still running → still on screen
    held!();
    await settleAsync();
  });

  it("ONBOARD_STEPS names steps the program (or the wSOL path) actually has", () => {
    // Cross-source guard, the CHAIN_PHASE_SECS idiom again: three of the five steps are instructions
    // in the program and have to keep existing under those names. `wrap` and `confirm` are client-side
    // (the native wSOL wrap, and the owner poll after the delegation CPI), so they are not asserted here.
    for (const [step, fn] of [["join", "join"], ["deposit", "deposit"], ["delegate", "delegate_bettor"]] as const) {
      expect(ONBOARD_STEPS).toContain(step);
      expect(paddockLibRs).toContain(`pub fn ${fn}(`);
    }
    expect(ONBOARD_STEPS).not.toContain("ready"); // the end of the work, not a piece of it
  });

  it("says nothing about a claim when there is nothing to say", async () => {
    const pools = [10n, 30n, 0n, 0n, 60n, 0n, 0n, 0n].map((n) => n * UNIT);
    const state = {
      race: raceSnap({ seq: 18n, pools, total: 100n * UNIT, history: ring([{ seq: 17n, winner: 0, multFp: 9_500_000n }]) }),
      bettor: { balance: 10n * UNIT, stakes: stakesOn(0, 4n * UNIT), raceSeq: null } as BettorSnap,
    };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    expect(book.claimWindow!()).toBeNull();                       // the u64::MAX sentinel: no ticket at all

    state.bettor = { balance: 10n * UNIT, stakes: stakesOn(0, 4n * UNIT), raceSeq: 18n };
    await book.refresh();
    expect(book.claimWindow!()).toBeNull();                       // the race ON SCREEN — undecided, not unclaimed

    // a settled ticket that backed a loser: the ring HAS the result, it is just worth nothing
    state.race = raceSnap({ seq: 18n, history: ring([{ seq: 17n, winner: 3, multFp: 9_500_000n }]) });
    state.bettor = { balance: 10n * UNIT, stakes: stakesOn(0, 4n * UNIT), raceSeq: 17n };
    await book.refresh();
    expect(book.claimWindow!()).toBeNull();
  });

  it("reports what an older ticket is owed and how much of the 32-race window is left", async () => {
    const multFp = 9_500_000n;                                    // 9.5x, as settle_pool would price it
    const stakes = stakesOn(0, 4n * UNIT);                        // 4 units on SLOT 0, which won race 17
    const state = {
      race: raceSnap({ seq: 20n, history: ring([{ seq: 17n, winner: 0, multFp }]) }),
      bettor: { balance: 10n * UNIT, stakes, raceSeq: 17n } as BettorSnap,
    };
    const book = chainBookSource(fakeClient(state).client);
    await book.refresh();
    const c = book.claimWindow!()!;
    expect(c.raceSeq).toBe(17);
    expect(c.amount).toBeCloseTo(Number(payoutOf(4n * UNIT, multFp)) / 1e7, 9); // 38 units
    expect(c.windowRaces).toBe(HISTORY_LEN);
    expect(c.racesLeft).toBe(HISTORY_LEN - 3);                    // race 20 is live; the slot dies at 17+32
    expect(c.expired).toBe(false);

    // one race off the edge: the ring slot now carries seq 49, so 17's result is simply gone
    state.race = raceSnap({ seq: 50n, history: ring([{ seq: 49n, winner: 0, multFp }]) });
    await book.refresh();
    expect(book.claimWindow!()).toEqual({ raceSeq: 17, amount: 0, racesLeft: 0, windowRaces: HISTORY_LEN, expired: true });
  });

  it("an aged-out ticket does not FAIL on-chain — it silently stops being worth anything", () => {
    // The premise the claim-window copy rests on, read off the program rather than assumed. `claim`
    // raises NoSuchResult (6008) only for the u64::MAX sentinel, and WrongPhase for the live race.
    // Past the ring there is no error at all: settle_ticket finds no result, credits zero, and claim
    // zeroes the stakes and resets the ticket anyway. place_bet's auto-settle does exactly the same.
    // So this is not an error the UI can catch — the amount just stops existing, which is why the
    // panel has to say it before it happens.
    const claimBody = /pub fn claim\(([\s\S]*?)\n    \}/.exec(paddockLibRs)?.[1] ?? "";
    expect(claimBody).toContain("require!(ticket.race_seq != u64::MAX, PaddockError::NoSuchResult)");
    expect(claimBody).toContain("require!(ticket.race_seq != race.seq, PaddockError::WrongPhase)");
    expect(claimBody).toContain("let credit = settle_ticket(race, ticket);");
    expect(claimBody).not.toMatch(/NoSuchResult[\s\S]*settle_ticket[\s\S]*NoSuchResult/); // no second guard after the lookup
    // and the lookup itself is the ring test, keyed by seq — nothing else decides staleness
    expect(paddockLibRs).toContain("let Some(result) = race.find_result(ticket.race_seq) else {");
  });

  it("polls on the WALL clock, not on the host's sim dt", async () => {
    // A throttled tab delivers a trickle of clamped dt while real seconds keep passing — and the
    // chain, and `secondsLeft()`, both run on real seconds. So the poll must too: 600 starved frames
    // inside one real second are still one read, and one frame after a real second has passed is a
    // read even though barely any dt went by.
    const state = { race: raceSnap(), bettor: null };
    const { client } = fakeClient(state);
    let reads = 0;
    const inner = client.raceSnapshot.bind(client);
    client.raceSnapshot = async () => { reads++; return inner(); };

    const t0 = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    const book = chainBookSource(client, { pollSecs: 1 });
    book.poll(1 / 60);                                   // the first frame reads immediately
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(1);
    for (let i = 0; i < 600; i++) book.poll(1 / 60);      // 10s of sim dt inside the SAME real instant
    expect(reads).toBe(1);
    clock.mockReturnValue(t0 + 1000);
    book.poll(0);                                        // a real second later, on no dt at all
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(2);
    clock.mockRestore();
  });
});
