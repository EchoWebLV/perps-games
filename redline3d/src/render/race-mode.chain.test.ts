// @vitest-environment jsdom
// The chain-driven half of race-mode's phase machine. Kept out of race-mode.test.ts on purpose: that
// file is the gate proving the browser-only path is untouched by all of this, and it has to keep
// passing UNMODIFIED. Nothing here constructs a chain client — the book is a hand-driven fake, so the
// phase logic is tested at frame resolution instead of at RPC resolution.
//
// The assertion this file exists for is the last one: the order the show finishes in is the order the
// book handed over at the lock, not the placeholder the market was paced with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createRaceGame, DEFAULT_GRID } from "./race-mode";
import type { BookPhase, BookSettle, RaceBookSource } from "./race-book-source";

// jsdom ships no canvas (same stub race-mode.test.ts installs) and GLB loads are irrelevant to the
// pacing math — the placeholder anchors race fine.
function installStubs() {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") return () => grad;
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(() => undefined as never);
}

/** A book race-mode can be driven against frame by frame. `phase`/`secondsLeft`/`order` are set by
 *  the test exactly as an ER snapshot would set them; everything else is inert. */
function fakeBook(init: { phase: BookPhase; secondsLeft: number; order: number[] | null }) {
  const N = DEFAULT_GRID.length;
  const zeros = () => new Array<number>(N).fill(0);
  const state = { ...init, locked: false, settledWith: null as number | null, polls: 0 };
  const book: RaceBookSource & { state: typeof state } = {
    state,
    openMarket() {},
    poll() { state.polls++; },
    phase: () => state.phase,
    secondsLeft: () => state.secondsLeft,
    entrants: () => zeros().map((_v, i) => i),
    pools: () => zeros().map(() => 10),
    total: () => 80,
    multipliers: () => zeros().map(() => 8),
    myStakes: zeros,
    wallet: () => 100,
    finishOrder: () => state.order,
    placeBet() {},
    pendingBet: () => null,
    lock() { state.locked = true; },
    settle(winnerId): BookSettle {
      state.settledWith = winnerId;
      return { winnerId, net: 0, winnerMult: 8, walletAfter: 100 };
    },
    credit() {},
    lastSettle: () => null,
    creditNote: () => null,
  };
  return book;
}

function makeGame(book: RaceBookSource, over: Record<string, unknown> = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const hudParent = document.createElement("div");
  return { hudParent, game: createRaceGame({ scene, camera, hudParent, grid: DEFAULT_GRID, seed: 42, lowTier: true, book, ...over }) };
}

/** Run `secs` of frames at 60fps, letting a callback move the fake chain clock alongside. */
function runFrames(game: { update(dt: number): void }, secs: number, onFrame?: (t: number) => void) {
  const h = 1 / 60;
  for (let t = 0; t < secs; t += h) { onFrame?.(t); game.update(h); }
}

beforeEach(installStubs);
afterEach(() => vi.restoreAllMocks());

describe("createRaceGame with a chain book", () => {
  it("stays in MARKET while the chain does, and shows the CHAIN's clock, not a 15s local one", () => {
    const book = fakeBook({ phase: "MARKET", secondsLeft: 9, order: null });
    const { game, hudParent } = makeGame(book);
    game.update(1 / 60);
    expect(game.phase()).toBe("MARKET");
    // the local machine would have locked after MARKET_TIME (15s); the chain says otherwise
    runFrames(game, 40, () => { book.state.secondsLeft = 9; });
    expect(game.phase()).toBe("MARKET");
    expect(hudParent.textContent).toContain("OPEN 9s"); // the panel is painting phaseEndsTs, not a local timer
  });

  it("re-solves the pacing on the lock: the rendered finish order is the CHAIN's order", () => {
    // A deliberately perverse order — the reverse of grid strength, so the field can only land on it
    // if the pacing was genuinely re-solved after the market closed. The placeholder order the market
    // was paced with (the grid order) is NOT this.
    const chainOrder = [7, 6, 5, 4, 3, 2, 1, 0];
    const book = fakeBook({ phase: "MARKET", secondsLeft: 5, order: null });
    let result: number[] = [];
    const { game } = makeGame(book, { onExit: (r: { finishOrder: number[] }) => { result = r.finishOrder; } });

    runFrames(game, 2, () => { book.state.secondsLeft = 5; });
    expect(game.phase()).toBe("MARKET");

    // the crank locks: phase flips and `order` appears in the same snapshot, exactly as on-chain
    book.state.phase = "RACING";
    book.state.order = chainOrder;
    let left = 40;
    runFrames(game, 45, () => { left = Math.max(0, left - 1 / 60); book.state.secondsLeft = left; });

    expect(game.phase()).toBe("FINISH");
    expect(book.state.locked).toBe(true);
    game.requestExit(); // FINISH is already reached, so the exit payload fires now
    expect(result).toEqual(chainOrder);
    expect(book.state.settledWith).toBe(chainOrder[0]); // the market was settled against the chain's winner
    game.dispose();
  });

  it("fits the whole show inside the chain's RACING window and holds at the flag", () => {
    // Walk the chain's whole 40s RACING window a frame at a time and record where the show is at each
    // second of it. This is the reconciliation, asserted: ~3s of countdown at the front, the ~36s
    // race, and the flag down with ~1s (TAIL_HOLD) still on the chain's clock.
    const chainOrder = [2, 0, 5, 1, 7, 3, 6, 4];
    const book = fakeBook({ phase: "RACING", secondsLeft: 40, order: chainOrder });
    const { game } = makeGame(book);
    const phaseAt: Record<number, string> = {};
    for (let f = 0; f < 40 * 60; f++) {
      book.state.secondsLeft = Math.max(0, 40 - f / 60);
      game.update(1 / 60);
      const sec = Math.floor(f / 60);
      if (!(sec in phaseAt)) phaseAt[sec] = game.phase();
    }
    expect(phaseAt[0]).toBe("COUNTDOWN");   // lights at the front of the window
    expect(phaseAt[2]).toBe("COUNTDOWN");
    expect(phaseAt[4]).toBe("RACING");
    expect(phaseAt[20]).toBe("RACING");
    expect(phaseAt[38]).toBe("RACING");
    expect(phaseAt[39]).toBe("FINISH");     // flag falls ~1s (TAIL_HOLD) before the chain settles
    game.dispose();
  });

  it("joining mid-race never shows a market that cannot be bet into, and resyncs to where the chain is", () => {
    const chainOrder = [1, 3, 0, 6, 2, 7, 5, 4];
    // first snapshot is a race already 25s old (15 left of the 40s window)
    const book = fakeBook({ phase: "RACING", secondsLeft: 15, order: chainOrder });
    const { game, hudParent } = makeGame(book);

    game.update(1 / 60);
    expect(game.phase()).toBe("RACING");                    // straight into the race, no market flash
    // the market panel is BUILT (its DOM always exists) but never shown — that is the thing being
    // asserted: a market nobody can bet into is never put on screen
    expect((hudParent.querySelector(".bp-panel") as HTMLElement).style.display).toBe("none");
    expect(hudParent.textContent).toMatch(/LAP [23]/);       // the field is already deep into the race

    let left = 15;
    runFrames(game, 16, () => { left = Math.max(0, left - 1 / 60); book.state.secondsLeft = left; });
    expect(game.phase()).toBe("FINISH");
    game.dispose();
  });

  it("resyncs to the current race when a backgrounded tab skips several seq", () => {
    const raceA = [0, 1, 2, 3, 4, 5, 6, 7];
    const raceB = [5, 2, 7, 0, 4, 1, 6, 3];
    const book = fakeBook({ phase: "RACING", secondsLeft: 40, order: raceA });
    let result: number[] = [];
    const { game } = makeGame(book, { onExit: (r: { finishOrder: number[] }) => { result = r.finishOrder; } });

    let left = 40;
    runFrames(game, 10, () => { left -= 1 / 60; book.state.secondsLeft = left; });
    expect(game.phase()).toBe("RACING");

    // the tab was hidden for minutes: several races went by and a NEW one is 8s into its window
    book.state.order = raceB;
    book.state.secondsLeft = 32;
    game.update(120); // one giant dt, the shape a throttled tab actually delivers

    // the show must be running race B — not finishing race A, whose pacing it was already committed to
    left = 32;
    runFrames(game, 33, () => { left = Math.max(0, left - 1 / 60); book.state.secondsLeft = left; });
    expect(game.phase()).toBe("FINISH");
    game.requestExit();
    expect(result).toEqual(raceB);
    game.dispose();
  });

  it("forces the race to the line when the chain settles first — the flag never lands after the result", () => {
    const chainOrder = [4, 0, 1, 2, 3, 5, 6, 7];
    const book = fakeBook({ phase: "RACING", secondsLeft: 40, order: chainOrder });
    let result: number[] = [];
    const { game } = makeGame(book, { onExit: (r: { finishOrder: number[] }) => { result = r.finishOrder; } });

    let left = 40;
    runFrames(game, 5, () => { left -= 1 / 60; book.state.secondsLeft = left; });
    expect(game.phase()).toBe("RACING");

    // the crank settles while the render is only seconds in (a stalled RPC, a slow client)
    book.state.phase = "FINISH";
    book.state.secondsLeft = 6;
    game.update(1 / 60);
    expect(game.phase()).toBe("FINISH");
    game.requestExit();
    expect(result).toEqual(chainOrder);
    game.dispose();
  });

  it("a book that never reports a phase leaves the local machine in charge; one that stops reporting freezes the show", () => {
    // Contract, stated in the interface: `phase() === null` means "I have no phase, you rule". A book
    // that always says null is the local sim, and race-mode must behave exactly as it always has —
    // its own 15s market, its own lock. This is why the HOST primes a chain book before handing it
    // over: an unprimed one would land in this branch and flash a local market over a live race.
    const book = fakeBook({ phase: "MARKET", secondsLeft: 12, order: [0, 1, 2, 3, 4, 5, 6, 7] });
    (book as { phase(): BookPhase | null }).phase = () => null;
    const { game } = makeGame(book);
    game.update(1 / 60);
    expect(game.phase()).toBe("MARKET");
    runFrames(game, 16);
    expect(game.phase()).not.toBe("MARKET"); // MARKET_TIME expired on the LOCAL clock, as designed
    game.dispose();

    // …but once a book HAS reported a phase, a later null (a dropped read) freezes the show rather
    // than handing the machine back to a local clock mid-race.
    let live = true;
    const book2 = fakeBook({ phase: "RACING", secondsLeft: 40, order: [3, 2, 1, 0, 7, 6, 5, 4] });
    (book2 as { phase(): BookPhase | null }).phase = () => (live ? "RACING" : null);
    const { game: g2 } = makeGame(book2);
    let left = 40;
    runFrames(g2, 10, () => { left -= 1 / 60; book2.state.secondsLeft = left; });
    expect(g2.phase()).toBe("RACING");
    live = false;
    runFrames(g2, 60, () => { book2.state.secondsLeft = 0; }); // chain long gone; nothing must advance
    expect(g2.phase()).toBe("RACING");
    g2.dispose();
  });

  it("the chain opens the next market — SKIP and RACE AGAIN do not", () => {
    const book = fakeBook({ phase: "MARKET", secondsLeft: 10, order: null });
    const { game, hudParent } = makeGame(book);
    game.update(1 / 60);
    (hudParent.querySelector(".bp-skip") as HTMLElement).click();
    game.update(1 / 60);
    expect(game.phase()).toBe("MARKET");   // SKIP is the local sim's privilege only
    expect(book.state.locked).toBe(false);

    // the chain's own roll into the next market is what re-opens one after a settle
    book.state.phase = "RACING";
    book.state.order = [1, 0, 2, 3, 4, 5, 6, 7];
    let left = 40;
    runFrames(game, 41, () => { left = Math.max(0, left - 1 / 60); book.state.secondsLeft = left; });
    expect(game.phase()).toBe("FINISH");
    runFrames(game, 20, () => { book.state.phase = "FINISH"; book.state.secondsLeft = 3; });
    expect(game.phase()).toBe("FINISH");   // and it STAYS there — no local FINISH_HOLD restart
    book.state.phase = "MARKET";
    book.state.order = null;
    book.state.secondsLeft = 15;
    game.update(1 / 60);
    expect(game.phase()).toBe("MARKET");
    game.dispose();
  });
});
