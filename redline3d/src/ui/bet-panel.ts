// Polymarket-style "WINNER" market for the race, in the game's neon-dark styling: pari-mutuel odds
// per car, a bet slip, a collapsed strip while racing, and a settlement card on finish.
//
// It owns NO MONEY. It used to: a module-level wallet it debited, bettors it invented, a settle()
// that paid itself. All of that moved behind `RaceBookSource` (render/race-book-source.ts), because
// the same pixels now have to render a browser sim OR an on-chain pari-mutuel pool in the ER, and a
// view that quietly mutates a wallet cannot render a wallet it does not own. What is left is the
// honest shape: render(ctx) paints what it is handed, onBet(fn) emits intent, and every number on
// screen came from the book.
//
// SLOT ≠ CAR: every id and array crossing this file is CAR-indexed (roster order). The book resolves
// the chain's starting-slot permutation before anything reaches here — see the note at the top of
// race-book-source.ts for why that matters.
import { onTap } from "./tap";
import type { BookClaim, BookOnboarding, BookSettle } from "../render/race-book-source";

export interface BetCar { id: number; name: string; color: string }
export type BetPhase = "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH";

/** Everything painted, per frame. No field here is remembered between renders — the book is the
 *  single source of truth for all of it, so the panel can never drift out of sync with the money. */
export interface BetRenderCtx {
  phase: BetPhase;
  marketRemaining: number;       // seconds left in MARKET OPEN
  raceLeaderName: string | null; // current on-track leader (RACING)
  pools: number[];               // per-car pool
  total: number;                 // sum of pools
  mults: number[];               // per-car payout multiplier — live while open, frozen after the lock
  stakes: number[];              // the player's own stake per car
  wallet: number;                // the player's money as ONE number (wallet + staged + claimable)
  /** What a single bet can spend RIGHT NOW — ≤ `wallet`, the difference being money that still has a
   *  refill to cross before it can back a bet. This, not `wallet`, is what gates BET. Null when the
   *  book has no such number to report (the local sim), and then `wallet` is the gate. */
  betable: number | null;
  pendingCar: number | null;     // a bet in flight on this car (the ER is fast, not instant)
  settle: BookSettle | null;     // the settled result, painted in the FINISH card
  credit: string | null;         // non-bet winnings line (owner podium), painted alongside it
  // The seat work running behind the scenes — a one-time build, or a top-up after the balance ran
  // short — plus anything a bet send came back with. Progress, never a flow the player drives.
  onboarding: BookOnboarding | null;
  claim: BookClaim | null;       // an older ticket still holding money, and what is left of its window
}

export interface BetPanel {
  el: HTMLElement;
  setRoster(cars: BetCar[]): void;
  render(ctx: BetRenderCtx): void;
  /** Fires on a BET tap with the tapped car and the selected chip stake. INTENT only — nothing on
   *  screen moves until the book comes back with new pools through render(). */
  onBet(fn: (carId: number, amount: number) => void): void;
  /** The stake chip currently selected — the host feeds it to the book's ensureFunded so the
   *  seat is staged for the bet the player is ABOUT to make, not the one they last made. */
  selectedStake(): number;
  onSkip(fn: () => void): void;
  onRaceAgain(fn: () => void): void;
  dispose(): void;
}

const STAKES = [1, 5, 20];

/** The chip a fresh panel comes up on. Exported because the host has to stage a seat for a stake
 *  before the player has touched a chip, and a second hardcoded 5 out there would be free to drift
 *  from this one. Must be a member of STAKES, or nothing renders as selected. */
export const DEFAULT_STAKE = 5;

/** How few races have to be left on a ticket's claim window before the notice reads as a warning
 *  rather than as a fact. Emphasis only — nothing is capped, blocked or expired by this number; the
 *  ring in the program is what decides that, and `claim.expired` is what reports it. */
const CLAIM_WARN_RACES = 8;

/** What each staging step is DOING, in the player's terms. The controller's vocabulary is the
 *  program's (join / wrap / deposit / delegate / confirm on the way in, claim / exit / undelegate /
 *  withdraw / unwrap on the way back out); this is the same sequence said out loud. One map covers
 *  both kinds — a step means the same thing whether it is running for a first seat or a top-up. No
 *  step names a duration — the sequence is the progress, the clock is not ours to promise. `ready`
 *  and `done` are transitions the book collapses to a stepless beat, so they are never rendered;
 *  they are here because the type is TOTAL over the step union on purpose — a thirteenth step added
 *  to `StageStep` has to break this build rather than quietly show the player a raw identifier. */
const STEP_LABEL: Record<NonNullable<BookOnboarding["step"]>, string> = {
  join: "Opening your account at the book",
  wrap: "Wrapping SOL to stake",
  deposit: "Staking your seat",
  delegate: "Delegating your seat to the rollup",
  confirm: "Waiting for the rollup to take your seat",
  ready: "Seat ready",
  claim: "Collecting your last win",
  exit: "Freeing your seat to top it up",
  undelegate: "Waiting for the rollup to hand it back",
  withdraw: "Gathering your balance",
  unwrap: "Unwrapping to SOL",
  done: "Seat freed",
};

/** A one-block notice: an uppercase head and a line of plain text under it, or null for "say
 *  nothing". Every notice the panel paints is this shape, so one renderer covers them all. */
interface Note { cls: string; head: string; body: string }

/** The seat work behind the scenes, as a line the player can read: a one-time build the first time,
 *  a top-up when the balance ran short. Idle and silent staging paints nothing — a book that COULD
 *  be staging but is not is not news. */
function onboardNote(o: BookOnboarding | null): Note | null {
  if (!o) return null;
  if (o.error) {
    const head = o.kind === "refill" ? "Top-up stopped" : "Setup stopped";
    return { cls: "stopped", head, body: o.error };
  }
  if (!o.step) return null;
  const head = o.kind === "refill" ? `Topping up · ${o.index} of ${o.of}` : `One-time setup · ${o.index} of ${o.of}`;
  const body = o.kind === "refill"
    ? `${STEP_LABEL[o.step] ?? o.step} — you can bet again next market.`
    : `${STEP_LABEL[o.step] ?? o.step} — later bets skip all of this.`;
  return { cls: "", head, body };
}

/** A failed bet send, as its own note beside (never instead of) staging progress. The two have
 *  different causes and different lifetimes: a tap refused BECAUSE a top-up was mid-flight must not
 *  be what erases the top-up explaining it. */
function betNote(o: BookOnboarding | null): Note | null {
  if (!o?.betError) return null;
  return { cls: "stopped", head: "Bet not placed", body: o.betError };
}

/** An older ticket, and whether its result is still on the chain to be paid from. */
function claimNote(c: BookClaim | null): Note | null {
  if (!c) return null;
  if (c.expired) {
    return {
      cls: "gone",
      head: `Race #${c.raceSeq} can no longer pay`,
      body: `Past the ${c.windowRaces}-race claim window — that result is no longer on the chain.`,
    };
  }
  const closing = c.racesLeft <= CLAIM_WARN_RACES;
  return {
    cls: closing ? "warn" : "",
    head: `$${c.amount.toFixed(2)} to collect · race #${c.raceSeq}`,
    body: closing
      ? `Claim window closing — ${c.racesLeft} of ${c.windowRaces} races left. Your next bet collects it.`
      : `Your next bet collects it — ${c.racesLeft} of ${c.windowRaces} races left.`,
  };
}

const STYLE_ID = "bet-panel-style";
// Two skins in one sheet. CLASSIC (base, unscoped) is the original dark-neon look. COMIC rules are
// scoped under `body.toon-ui` (toggled by toon.ts): thick near-black ink borders, chunky corners,
// HARD offset drop shadows (no blur), flat bright fills, heavy type. Same layout/info either way.
const CSS = `
.bp-root{position:fixed;inset:0;pointer-events:none;font-family:'Chakra Petch',ui-monospace,monospace;color:#eaf2ff;z-index:25;}
.bp-panel{position:absolute;right:14px;top:14px;width:340px;max-height:calc(100vh - 28px);overflow:auto;background:rgba(9,6,22,.82);border:1px solid rgba(122,90,220,.5);border-radius:14px;padding:14px;box-shadow:0 0 34px rgba(120,60,220,.3),inset 0 0 22px rgba(40,20,80,.4);backdrop-filter:blur(7px);pointer-events:auto;}
.bp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}
.bp-title{font-size:14px;font-weight:700;letter-spacing:.12em;color:#9ad7ff;text-transform:uppercase;}
.bp-timer{font-size:12px;font-weight:700;color:#ffd166;font-variant-numeric:tabular-nums;}
.bp-sub{display:flex;justify-content:space-between;font-size:11px;color:#8b95c9;margin-bottom:10px;letter-spacing:.04em;}
.bp-pool{color:#41d67f;font-weight:700;font-variant-numeric:tabular-nums;}
.bp-rows{display:flex;flex-direction:column;gap:4px;}
.bp-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);}
.bp-dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 8px currentColor;}
.bp-nm{flex:1;min-width:0;}
.bp-nm b{display:block;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bp-nm span{font-size:9px;color:#8b95c9;font-variant-numeric:tabular-nums;letter-spacing:.02em;}
.bp-prob{text-align:right;font-size:12px;font-weight:700;color:#eaf2ff;font-variant-numeric:tabular-nums;min-width:60px;}
.bp-prob small{display:block;font-size:9px;font-weight:600;color:#ffd166;}
.bp-bet{cursor:pointer;font-family:inherit;font-size:11px;font-weight:700;letter-spacing:.04em;color:#04121a;background:linear-gradient(180deg,#4ff0ff,#27b7e7);border:none;border-radius:6px;padding:6px 9px;box-shadow:0 0 14px rgba(39,231,255,.4);-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-bet:active{transform:translateY(1px);}
.bp-bet[disabled]{opacity:.35;filter:grayscale(.6);cursor:default;box-shadow:none;}
/* in-flight bet: reads as WORKING, not unavailable — it sits on top of [disabled] (same specificity,
   declared later) so the greyed-out look never swallows the one row that is actually doing something */
.bp-bet.pending{opacity:1;filter:none;background:linear-gradient(180deg,#ffe08a,#f0b429);box-shadow:0 0 14px rgba(255,209,102,.5);}
.bp-stakes{display:flex;gap:7px;margin:12px 0 8px;}
.bp-chip{flex:1;text-align:center;cursor:pointer;font-size:13px;font-weight:700;padding:8px 0;border-radius:8px;border:1px solid rgba(122,90,220,.45);background:rgba(255,255,255,.03);color:#c9d6ff;-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-chip.sel{background:rgba(39,231,255,.16);border-color:#27e7ff;color:#eaf7ff;box-shadow:0 0 12px rgba(39,231,255,.35);}
.bp-slip{margin-top:6px;border-top:1px solid rgba(122,90,220,.3);padding-top:8px;display:flex;flex-direction:column;gap:4px;min-height:16px;}
.bp-slipline{font-size:11px;color:#c9d6ff;display:flex;justify-content:space-between;}
.bp-slipline em{color:#41d67f;font-style:normal;font-weight:700;}
.bp-empty{font-size:11px;color:#6b74a6;}
/* notices: the seat work running behind the scenes, a bet the book refused, and an older ticket's
   claim window. One block three times, recoloured by class — amber = working / closing, red =
   stopped / refused / gone. */
.bp-note{margin-top:10px;border-radius:8px;padding:7px 9px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);}
.bp-note b{display:block;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:2px;}
.bp-note span{display:block;font-size:11px;line-height:1.42;color:#8b95c9;}
.bp-onboard{border-color:rgba(255,209,102,.5);background:rgba(255,209,102,.1);}
.bp-onboard b{color:#ffd166;}
.bp-onboard.stopped{border-color:rgba(255,107,139,.55);background:rgba(255,107,139,.1);}
.bp-onboard.stopped b{color:#ff6b8b;}
.bp-beterr{border-color:rgba(255,107,139,.55);background:rgba(255,107,139,.1);}
.bp-beterr b{color:#ff6b8b;}
.bp-claim{border-color:rgba(65,214,127,.45);background:rgba(65,214,127,.08);}
.bp-claim b{color:#41d67f;}
.bp-claim.warn{border-color:rgba(255,209,102,.55);background:rgba(255,209,102,.1);}
.bp-claim.warn b{color:#ffd166;}
.bp-claim.gone{border-color:rgba(255,107,139,.5);background:rgba(255,107,139,.08);}
.bp-claim.gone b{color:#ff6b8b;}
.bp-foot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;}
.bp-wallet{font-size:13px;font-weight:700;}
.bp-wallet span{color:#41d67f;font-variant-numeric:tabular-nums;}
.bp-skip{cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.1em;color:#c9d6ff;background:rgba(255,255,255,.05);border:1px solid rgba(122,90,220,.5);border-radius:8px;padding:8px 14px;-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-strip{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:16px;align-items:center;background:rgba(9,6,22,.8);border:1px solid rgba(122,90,220,.45);border-radius:99px;padding:8px 18px;box-shadow:0 0 20px rgba(120,60,220,.25);font-size:12px;pointer-events:none;}
.bp-strip b{color:#ffd166;}
.bp-strip .lead{color:#27e7ff;}
.bp-settle{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(430px,86vw);text-align:center;background:rgba(9,6,22,.92);border:1px solid rgba(255,93,160,.55);border-radius:16px;padding:24px 22px;box-shadow:0 0 46px rgba(255,60,160,.35),inset 0 0 26px rgba(60,20,80,.5);pointer-events:auto;}
.bp-settle .flag{font-size:32px;}
.bp-settle .win{font-size:24px;font-weight:700;margin:4px 0 2px;}
.bp-settle .paid{font-size:13px;color:#ffd166;margin-bottom:12px;}
.bp-net{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;margin-bottom:2px;}
.bp-net.up{color:#41d67f;}.bp-net.down{color:#ff6b8b;}
.bp-credit{font-size:13px;font-weight:700;color:#41d67f;font-variant-numeric:tabular-nums;margin-bottom:6px;}
.bp-walletbig{font-size:13px;color:#c9d6ff;margin-bottom:16px;}
.bp-again{cursor:pointer;font-family:inherit;font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#04121a;background:linear-gradient(180deg,#4ff0ff,#27b7e7);border:none;border-radius:10px;padding:11px 26px;box-shadow:0 0 22px rgba(39,231,255,.55);-webkit-tap-highlight-color:transparent;user-select:none;}
.bp-again:active{transform:translateY(1px);}

/* ── COMIC skin (active when body.toon-ui) ── */
body.toon-ui .bp-root{color:#f4f0ff;}
body.toon-ui .bp-panel{background:#241640;border:3px solid #0a0812;border-radius:16px;box-shadow:6px 6px 0 rgba(8,5,16,.9);backdrop-filter:none;}
body.toon-ui .bp-title{font-weight:800;letter-spacing:.10em;color:#ffe08a;}
body.toon-ui .bp-timer{font-weight:800;}
body.toon-ui .bp-sub{color:#b3a7d6;}
body.toon-ui .bp-pool{color:#3ff08a;font-weight:800;}
body.toon-ui .bp-rows{gap:5px;}
body.toon-ui .bp-row{border-radius:9px;background:#31204d;border:2px solid #0a0812;}
body.toon-ui .bp-dot{width:12px;height:12px;box-shadow:none;border:2px solid #0a0812;}
body.toon-ui .bp-nm b{font-weight:700;}
body.toon-ui .bp-nm span{color:#b3a7d6;}
body.toon-ui .bp-prob{font-weight:800;color:#f4f0ff;}
body.toon-ui .bp-prob small{font-weight:700;}
body.toon-ui .bp-bet{font-weight:800;background:#2de2e6;border:2px solid #0a0812;border-radius:8px;padding:6px 10px;box-shadow:2px 2px 0 rgba(8,5,16,.8);}
body.toon-ui .bp-bet:active{transform:translate(2px,2px);box-shadow:none;}
body.toon-ui .bp-bet[disabled]{opacity:.4;}
body.toon-ui .bp-bet.pending{opacity:1;background:#ffd166;box-shadow:2px 2px 0 rgba(8,5,16,.8);}
body.toon-ui .bp-chip{font-weight:800;border:2px solid #0a0812;border-radius:9px;background:#31204d;color:#e6ddff;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
body.toon-ui .bp-chip.sel{background:#2de2e6;border-color:#0a0812;color:#04121a;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
body.toon-ui .bp-slip{margin-top:8px;border-top:2px dashed #4a3670;}
body.toon-ui .bp-slipline{color:#e6ddff;}
body.toon-ui .bp-slipline em{color:#3ff08a;font-weight:800;}
body.toon-ui .bp-empty{color:#8a7db3;}
body.toon-ui .bp-note{border:2px solid #0a0812;border-radius:9px;box-shadow:2px 2px 0 rgba(8,5,16,.7);background:#31204d;}
body.toon-ui .bp-note b{font-weight:800;}
body.toon-ui .bp-note span{color:#e6ddff;}
body.toon-ui .bp-onboard{background:#4a3a12;}
body.toon-ui .bp-onboard b{color:#ffd166;}
body.toon-ui .bp-onboard.stopped{background:#4a1a29;}
body.toon-ui .bp-onboard.stopped b{color:#ff8fa3;}
body.toon-ui .bp-beterr{background:#4a1a29;}
body.toon-ui .bp-beterr b{color:#ff8fa3;}
body.toon-ui .bp-claim{background:#16402a;}
body.toon-ui .bp-claim b{color:#3ff08a;}
body.toon-ui .bp-claim.warn{background:#4a3a12;}
body.toon-ui .bp-claim.warn b{color:#ffd166;}
body.toon-ui .bp-claim.gone{background:#4a1a29;}
body.toon-ui .bp-claim.gone b{color:#ff8fa3;}
body.toon-ui .bp-wallet{font-weight:800;}
body.toon-ui .bp-wallet span{color:#3ff08a;}
body.toon-ui .bp-skip{font-weight:800;letter-spacing:.08em;color:#e6ddff;background:#31204d;border:2px solid #0a0812;border-radius:9px;box-shadow:2px 2px 0 rgba(8,5,16,.8);}
body.toon-ui .bp-skip:active{transform:translate(2px,2px);box-shadow:none;}
body.toon-ui .bp-strip{background:#241640;border:3px solid #0a0812;padding:8px 20px;box-shadow:4px 4px 0 rgba(8,5,16,.9);font-weight:700;}
body.toon-ui .bp-strip b{color:#ffd166;font-weight:800;}
body.toon-ui .bp-strip .lead{color:#2de2e6;font-weight:800;}
body.toon-ui .bp-settle{background:#241640;border:4px solid #0a0812;border-radius:18px;box-shadow:8px 8px 0 rgba(8,5,16,.9);}
body.toon-ui .bp-settle .flag{font-size:36px;}
body.toon-ui .bp-settle .win{font-weight:800;}
body.toon-ui .bp-settle .paid{font-weight:700;}
body.toon-ui .bp-net{font-size:32px;font-weight:800;}
body.toon-ui .bp-net.up{color:#3ff08a;}
body.toon-ui .bp-credit{color:#3ff08a;font-weight:800;}
body.toon-ui .bp-walletbig{color:#e6ddff;font-weight:700;}
body.toon-ui .bp-again{font-weight:800;letter-spacing:.10em;background:#2de2e6;border:3px solid #0a0812;border-radius:12px;box-shadow:4px 4px 0 rgba(8,5,16,.9);}
body.toon-ui .bp-again:active{transform:translate(3px,3px);box-shadow:1px 1px 0 rgba(8,5,16,.9);}
`;

export function createBetPanel(parent: HTMLElement = document.body): BetPanel {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.createElement("div");
  root.className = "bp-root";
  root.innerHTML = `
    <div class="bp-panel">
      <div class="bp-head"><span class="bp-title">Winner Market</span><span class="bp-timer"></span></div>
      <div class="bp-sub"><span>Pari-mutuel · 5% rake</span><span>Pool <span class="bp-pool">$0</span></span></div>
      <div class="bp-rows"></div>
      <div class="bp-stakes"></div>
      <div class="bp-slip"></div>
      <div class="bp-note bp-onboard" style="display:none"><b></b><span></span></div>
      <div class="bp-note bp-beterr" style="display:none"><b></b><span></span></div>
      <div class="bp-note bp-claim" style="display:none"><b></b><span></span></div>
      <div class="bp-foot">
        <span class="bp-wallet">Wallet <span>$100.00</span></span>
        <span class="bp-skip">SKIP →</span>
      </div>
    </div>
    <div class="bp-strip" style="display:none"></div>
    <div class="bp-settle" style="display:none">
      <div class="flag">🏁</div>
      <div class="win"></div>
      <div class="paid"></div>
      <div class="bp-net"></div>
      <div class="bp-credit" style="display:none"></div>
      <div class="bp-walletbig"></div>
      <button class="bp-again" type="button">Race Again</button>
    </div>`;
  parent.appendChild(root);

  const panelEl = root.querySelector(".bp-panel") as HTMLElement;
  const timerEl = root.querySelector(".bp-timer") as HTMLElement;
  const poolEl = root.querySelector(".bp-pool") as HTMLElement;
  const rowsEl = root.querySelector(".bp-rows") as HTMLElement;
  const stakesEl = root.querySelector(".bp-stakes") as HTMLElement;
  const slipEl = root.querySelector(".bp-slip") as HTMLElement;
  const onboardEl = root.querySelector(".bp-onboard") as HTMLElement;
  const betErrEl = root.querySelector(".bp-beterr") as HTMLElement;
  const claimEl = root.querySelector(".bp-claim") as HTMLElement;
  const walletEl = root.querySelector(".bp-wallet span") as HTMLElement;
  const skipEl = root.querySelector(".bp-skip") as HTMLElement;
  const stripEl = root.querySelector(".bp-strip") as HTMLElement;
  const settleEl = root.querySelector(".bp-settle") as HTMLElement;
  const winEl = settleEl.querySelector(".win") as HTMLElement;
  const paidEl = settleEl.querySelector(".paid") as HTMLElement;
  const netEl = settleEl.querySelector(".bp-net") as HTMLElement;
  const creditEl = settleEl.querySelector(".bp-credit") as HTMLElement;
  const walletBigEl = settleEl.querySelector(".bp-walletbig") as HTMLElement;
  const againBtn = settleEl.querySelector(".bp-again") as HTMLElement;

  // ---- view state ONLY: the roster, which chip is selected, and where to send a bet. Everything
  // else on screen arrives per-frame in the render ctx and is never cached here. ----
  let cars: BetCar[] = [];
  let selStake = DEFAULT_STAKE;
  let betFn: ((carId: number, amount: number) => void) | null = null;

  // per-car row element refs
  const rows: Array<{ row: HTMLElement; prob: HTMLElement; mult: HTMLElement; pool: HTMLElement; bet: HTMLButtonElement }> = [];

  function buildStakeChips() {
    stakesEl.innerHTML = "";
    for (const s of STAKES) {
      const chip = document.createElement("div");
      chip.className = "bp-chip" + (s === selStake ? " sel" : "");
      chip.textContent = `$${s}`;
      onTap(chip, () => { selStake = s; refreshStakeSel(); });
      stakesEl.appendChild(chip);
    }
  }
  function refreshStakeSel() {
    stakesEl.querySelectorAll(".bp-chip").forEach((c, i) => c.classList.toggle("sel", STAKES[i] === selStake));
  }

  /** Paint one notice block, or hide it. `textContent` throughout: a note's body can be a chain
   *  error's message, which is text from outside this file and never markup. */
  function paintNote(el: HTMLElement, base: string, note: Note | null) {
    el.style.display = note ? "block" : "none";
    if (!note) return;
    el.className = `bp-note ${base}${note.cls ? ` ${note.cls}` : ""}`;
    (el.firstElementChild as HTMLElement).textContent = note.head;
    (el.lastElementChild as HTMLElement).textContent = note.body;
  }

  return {
    el: root,
    setRoster(list) {
      cars = list;
      rowsEl.innerHTML = "";
      rows.length = 0;
      for (const c of cars) {
        const row = document.createElement("div");
        row.className = "bp-row";
        row.innerHTML = `
          <span class="bp-dot" style="background:${c.color};color:${c.color}"></span>
          <span class="bp-nm"><b>${c.name}</b><span class="bp-pool2"></span></span>
          <span class="bp-prob">0%<small>—</small></span>
          <button class="bp-bet" type="button">BET</button>`;
        rowsEl.appendChild(row);
        const bet = row.querySelector(".bp-bet") as HTMLButtonElement;
        // `disabled` is the only gate: render() sets it from what a bet can spend, the phase and any
        // in-flight bet, so the affordance and the guard are the same fact. jsdom + keyboard Enter still reach
        // this handler on a disabled button, hence the explicit check rather than trusting the browser.
        onTap(bet, () => { if (!bet.disabled) betFn?.(c.id, selStake); });
        rows.push({
          row,
          prob: row.querySelector(".bp-prob") as HTMLElement,
          mult: row.querySelector(".bp-prob small") as HTMLElement,
          pool: row.querySelector(".bp-pool2") as HTMLElement,
          bet,
        });
      }
      buildStakeChips();
    },
    render(ctx) {
      const showPanel = ctx.phase === "MARKET";
      panelEl.style.display = showPanel ? "block" : "none";
      stripEl.style.display = (ctx.phase === "COUNTDOWN" || ctx.phase === "RACING") ? "flex" : "none";
      settleEl.style.display = ctx.phase === "FINISH" ? "block" : "none";
      // implied probability = this car's share of the pool; the ¢ price is the same number, which is
      // the whole point of a pari-mutuel market and why both are printed off one figure.
      const T = ctx.total || 1;
      const pending = ctx.pendingCar !== null;
      // What one bet can spend right now decides the button — never the wallet figure beside it, and
      // never the mere fact that staging is running. A 15s market will not wait for a seat to be
      // built, so a tap that cannot be funded has to be a disabled button with an honest line under
      // it (the note says what is crossing), not a promise the book would go on to refuse.
      const betable = ctx.betable ?? ctx.wallet;
      // A seat mid-move cannot take a bet: while any staging step is in flight the delegated pair
      // may be undelegated at this instant, and `betable` can have come off a stale ER clone that
      // still reads high — a balance saying yes to a send the chain is certain to refuse. The
      // honest gate is OFF, with the progress note right there saying why.
      const stagingInFlight = ctx.onboarding !== null && ctx.onboarding.step !== null;
      const canFund = betable >= selStake && !stagingInFlight;

      if (showPanel) {
        timerEl.textContent = `OPEN ${Math.max(0, Math.ceil(ctx.marketRemaining))}s`;
        poolEl.textContent = `$${ctx.total.toFixed(0)}`;
        rows.forEach((r, i) => {
          const prob = ctx.pools[i] / T;
          r.prob.firstChild!.textContent = `${Math.round(prob * 100)}% · ${Math.round(prob * 100)}¢`;
          r.mult.textContent = `x${ctx.mults[i].toFixed(2)}`;
          r.pool.textContent = `$${ctx.pools[i].toFixed(0)} pool`;
          // One bet in flight at a time — the book serialises them, so every button locks while any
          // send is outstanding and the one being sent says so instead of going grey and silent.
          const inFlight = ctx.pendingCar === i;
          r.bet.disabled = pending || !canFund;
          r.bet.classList.toggle("pending", inFlight);
          r.bet.textContent = inFlight ? "···" : "BET";
        });
        walletEl.textContent = `$${ctx.wallet.toFixed(2)}`;

        // bet slip
        slipEl.innerHTML = "";
        const any = ctx.stakes.some((s) => s > 0);
        if (!any) {
          const e = document.createElement("div");
          e.className = "bp-empty"; e.textContent = "No positions yet — pick a car.";
          slipEl.appendChild(e);
        } else {
          ctx.stakes.forEach((s, i) => {
            if (s <= 0) return;
            const pays = s * ctx.mults[i];
            const line = document.createElement("div");
            line.className = "bp-slipline";
            line.innerHTML = `<span>$${s.toFixed(0)} on ${cars[i].name}</span><em>→ $${pays.toFixed(2)}</em>`;
            slipEl.appendChild(line);
          });
        }

        // Below the slip: what the book is doing behind the scenes, what it said about the last bet
        // sent, and anything an older ticket is still owed. Three independent facts, so three
        // independent notes — any of them can be absent, and none of them can hide another. All are
        // the book's facts, never the panel's.
        paintNote(onboardEl, "bp-onboard", onboardNote(ctx.onboarding));
        paintNote(betErrEl, "bp-beterr", betNote(ctx.onboarding));
        paintNote(claimEl, "bp-claim", claimNote(ctx.claim));
      }

      if (stripEl.style.display === "flex") {
        const myBets = ctx.stakes.map((s, i) => ({ s, i })).filter((b) => b.s > 0);
        const posTxt = myBets.length
          ? myBets.map((b) => `<b>$${b.s.toFixed(0)} ${cars[b.i].name}</b> → $${(b.s * ctx.mults[b.i]).toFixed(2)}`).join(" · ")
          : "<span style='color:#6b74a6'>no bet placed</span>";
        const lead = ctx.raceLeaderName ? `<span class="lead">LEADING ${ctx.raceLeaderName}</span>` : "";
        stripEl.innerHTML = `${posTxt} ${lead}`;
      }

      if (ctx.phase === "FINISH") {
        if (ctx.settle) {
          const w = cars[ctx.settle.winnerId];
          winEl.textContent = `${w.name} WINS`;
          winEl.style.color = w.color;
          paidEl.textContent = `market paid x${ctx.settle.winnerMult.toFixed(2)}`;
          const up = ctx.settle.net >= 0;
          netEl.textContent = `${up ? "+" : "−"}$${Math.abs(ctx.settle.net).toFixed(2)}`;
          netEl.className = "bp-net " + (up ? "up" : "down");
        }
        creditEl.textContent = ctx.credit ?? "";
        creditEl.style.display = ctx.credit ? "block" : "none";
        // the live balance, not a figure captured at settle time — a credit landing after the payout
        // (owner podium) has to show up here too, and reading it off the ctx makes that automatic
        walletBigEl.textContent = `Wallet: $${ctx.wallet.toFixed(2)}`;
      }
    },
    onBet(fn) { betFn = fn; },
    selectedStake: () => selStake,
    onSkip(fn) { onTap(skipEl, () => fn()); },
    onRaceAgain(fn) { onTap(againBtn, () => fn()); },
    dispose() { root.remove(); },
  };
}
