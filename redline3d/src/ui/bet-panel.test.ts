// @vitest-environment jsdom
// The panel owns no money any more (that moved behind RaceBookSource), so what is worth testing is
// exactly the two halves of a view: it paints what it is handed, and it emits intent without touching
// anything itself. The old tests asserted on a wallet the panel mutated — there is no such wallet now.
import { describe, expect, it } from "vitest";
import { createBetPanel, DEFAULT_STAKE, type BetRenderCtx } from "./bet-panel";

const CARS = [
  { id: 0, name: "Bedrock", color: "#ffd166" },
  { id: 1, name: "DeLorean", color: "#27e7ff" },
  { id: 2, name: "Trabant", color: "#ff6b8b" },
];

/** A full render ctx with the money already resolved, as the book hands it over. */
function ctx(over: Partial<BetRenderCtx> = {}): BetRenderCtx {
  const pools = over.pools ?? [60, 30, 10];
  const total = pools.reduce((a, b) => a + b, 0);
  return {
    phase: "MARKET",
    marketRemaining: 12.3,
    raceLeaderName: null,
    pools,
    total,
    mults: pools.map((p) => (p > 0 ? (total * 0.95) / p : 0)),
    stakes: [0, 0, 0],
    wallet: 100,
    betable: null, // no book-reported spendable → the wallet is the gate (the local sim)
    pendingCar: null,
    settle: null,
    credit: null,
    onboarding: null,
    claim: null,
    ...over,
    // `total`/`mults` follow `pools` unless the caller overrode them explicitly
    ...(over.total !== undefined ? { total: over.total } : {}),
  };
}

function mount() {
  const el = document.createElement("div");
  const panel = createBetPanel(el);
  panel.setRoster(CARS);
  return { el, panel };
}

const betButtons = (el: HTMLElement) => Array.from(el.querySelectorAll(".bp-bet")) as HTMLButtonElement[];

describe("betPanel renders what it is given", () => {
  it("paints pools, implied odds, multipliers and the wallet straight off the ctx", () => {
    const { el, panel } = mount();
    panel.render(ctx());
    const text = el.textContent ?? "";
    expect(text).toContain("$100"); // pool total, from ctx.total
    expect(text).toContain("60%");  // 60/100 implied probability for Bedrock
    expect(text).toContain("10%");  // 10/100 for Trabant
    expect(text).toContain("x1.58"); // 100*0.95/60
    expect(text).toContain("$100.00"); // wallet
    expect(text).toContain("No positions yet");
    panel.dispose();
  });

  it("moves every figure when the ctx moves — the panel caches nothing between renders", () => {
    const { el, panel } = mount();
    panel.render(ctx());
    panel.render(ctx({ pools: [10, 30, 60], wallet: 42.5 }));
    const text = el.textContent ?? "";
    expect(text).toContain("10%");     // Bedrock is now the long shot
    expect(text).toContain("$42.50");  // and the wallet followed the ctx down
    panel.dispose();
  });

  it("lists the player's stakes in the bet slip with what they would pay", () => {
    const { el, panel } = mount();
    panel.render(ctx({ stakes: [5, 0, 0] }));
    const text = el.textContent ?? "";
    expect(text).toContain("$5 on Bedrock");
    expect(text).toContain("$7.92"); // 5 × 1.5833
    expect(text).not.toContain("No positions yet");
    panel.dispose();
  });

  it("disables betting when the wallet cannot cover the selected stake", () => {
    const { el, panel } = mount();
    panel.render(ctx({ wallet: 0 }));
    expect(betButtons(el).every((b) => b.disabled)).toBe(true);
    panel.render(ctx({ wallet: 100 }));
    expect(betButtons(el).some((b) => b.disabled)).toBe(false);
    panel.dispose();
  });
});

describe("betPanel emits intent instead of moving money", () => {
  it("reports the tapped car and the selected stake, and changes nothing on screen by itself", () => {
    const { el, panel } = mount();
    const seen: Array<[number, number]> = [];
    panel.onBet((carId, amount) => seen.push([carId, amount]));
    panel.render(ctx());
    const poolsBefore = el.textContent;

    betButtons(el)[1].click();

    expect(seen).toEqual([[1, 5]]); // default chip is $5
    expect(el.textContent).toBe(poolsBefore); // nothing repainted — the book has not answered yet
    panel.dispose();
  });

  it("emits the stake the player selected on the chips", () => {
    const { el, panel } = mount();
    const seen: Array<[number, number]> = [];
    panel.onBet((carId, amount) => seen.push([carId, amount]));
    panel.render(ctx());
    (el.querySelectorAll(".bp-chip")[2] as HTMLElement).click(); // $20
    betButtons(el)[0].click();
    expect(seen).toEqual([[0, 20]]);
    panel.dispose();
  });
});

describe("betPanel pending state", () => {
  it("marks the in-flight car, locks every button, and refuses a second bet until it clears", () => {
    const { el, panel } = mount();
    const seen: Array<[number, number]> = [];
    panel.onBet((carId, amount) => seen.push([carId, amount]));
    panel.render(ctx({ pendingCar: 1 }));

    const btns = betButtons(el);
    expect(btns[1].textContent).toBe("···");
    expect(btns[1].classList.contains("pending")).toBe(true);
    expect(btns.every((b) => b.disabled)).toBe(true); // one send at a time

    // force the handler past the browser's own disabled-click suppression: the guard must be ours
    btns[0].dispatchEvent(new Event("click"));
    btns[1].dispatchEvent(new Event("click"));
    expect(seen).toEqual([]);

    panel.render(ctx()); // book confirmed → back to a normal, bettable row
    expect(btns[1].textContent).toBe("BET");
    expect(btns[1].classList.contains("pending")).toBe(false);
    expect(btns[1].disabled).toBe(false);
    panel.dispose();
  });
});

describe("betPanel BET gate", () => {
  it("gates BET on betable, not on the presence of onboarding", () => {
    const { el, panel } = mount();
    // A seat mid-top-up: there is money on screen (wallet counts the SOL still in the wallet and
    // whatever is crossing back) and $1 a bet can actually spend. The clause this replaces let the
    // mere existence of onboarding un-gate the button, which promised a bet the book would bounce.
    const refilling = { kind: "refill" as const, step: "withdraw" as const, index: 4, of: 9, error: null, betError: null };
    panel.render(ctx({ wallet: 100, betable: 1, onboarding: refilling }));
    expect(betButtons(el).every((b) => b.disabled)).toBe(true);
    // and it is the number that un-gates it, with the very same top-up still running
    panel.render(ctx({ wallet: 100, betable: 5, onboarding: refilling }));
    expect(betButtons(el).some((b) => b.disabled)).toBe(false);
    panel.dispose();
  });

  it("gates on wallet when the book reports no betable", () => {
    const { el, panel } = mount();
    // the local sim has no seat and no staging: its wallet IS what a bet can spend
    panel.render(ctx({ betable: null, wallet: 100 }));
    expect(betButtons(el).some((b) => b.disabled)).toBe(false);
    panel.render(ctx({ betable: null, wallet: 1 }));
    expect(betButtons(el).every((b) => b.disabled)).toBe(true);
    panel.dispose();
  });

  it("gates on the chip the player selected, not on a fixed stake", () => {
    const { el, panel } = mount();
    panel.render(ctx({ betable: 1, wallet: 1 }));
    expect(betButtons(el).every((b) => b.disabled)).toBe(true); // $5 chip, $1 to spend
    (el.querySelectorAll(".bp-chip")[0] as HTMLElement).click(); // $1
    panel.render(ctx({ betable: 1, wallet: 1 }));
    expect(betButtons(el).some((b) => b.disabled)).toBe(false);
    panel.dispose();
  });
});

describe("betPanel selected stake", () => {
  it("exposes the selected stake", () => {
    const { el, panel } = mount();
    // the host stages the seat for the bet the player is ABOUT to make, so it has to be able to ask
    expect(panel.selectedStake()).toBe(DEFAULT_STAKE);
    expect(DEFAULT_STAKE).toBe(5);
    (el.querySelectorAll(".bp-chip")[0] as HTMLElement).click(); // $1
    expect(panel.selectedStake()).toBe(1);
    (el.querySelectorAll(".bp-chip")[2] as HTMLElement).click(); // $20
    expect(panel.selectedStake()).toBe(20);
    panel.dispose();
  });
});

describe("betPanel onboarding notice", () => {
  const onboardEl = (el: HTMLElement) => el.querySelector(".bp-onboard") as HTMLElement;
  const betErrEl = (el: HTMLElement) => el.querySelector(".bp-beterr") as HTMLElement;

  it("says nothing at all when the book has no onboarding, or has one that is idle", () => {
    const { el, panel } = mount();
    panel.render(ctx());
    expect(onboardEl(el).style.display).toBe("none");
    // a book that CAN onboard but is not doing so is not news
    panel.render(ctx({ onboarding: { kind: "setup", step: null, index: 0, of: 5, error: null, betError: null } }));
    expect(onboardEl(el).style.display).toBe("none");
    panel.dispose();
  });

  it("names the step and its place in the sequence, and says the wait is one-time", () => {
    const { el, panel } = mount();
    panel.render(ctx({ onboarding: { kind: "setup", step: "delegate", index: 4, of: 5, error: null, betError: null } }));
    const text = onboardEl(el).textContent ?? "";
    expect(onboardEl(el).style.display).toBe("block");
    expect(text).toContain("4 of 5");
    expect(text).toContain("Delegating your seat");
    expect(text).toContain("later bets skip all of this");
    // no wall-clock promise anywhere in the copy — the step is the progress, the duration is not ours
    expect(text).not.toMatch(/second|minute|~|\d+s\b/i);

    panel.render(ctx({ onboarding: { kind: "setup", step: "confirm", index: 5, of: 5, error: null, betError: null } }));
    expect(onboardEl(el).textContent).toContain("5 of 5");
    panel.dispose();
  });

  it("shows what stopped the seat, in the book's own words", () => {
    const { el, panel } = mount();
    panel.render(ctx({
      onboarding: { kind: "setup", step: null, index: 0, of: 5, error: "Your wallet needs about 0.02 SOL to open a seat.", betError: null },
    }));
    expect(onboardEl(el).className).toContain("stopped");
    expect(onboardEl(el).textContent).toContain("Setup stopped");
    expect(onboardEl(el).textContent).toContain("Your wallet needs about 0.02 SOL");
    expect(betErrEl(el).style.display).toBe("none"); // nothing was sent, so nothing was refused
    panel.dispose();
  });

  it("paints a top-up note for kind refill", () => {
    const { el, panel } = mount();
    panel.render(ctx({ onboarding: { kind: "refill", step: "undelegate", index: 3, of: 9, error: null, betError: null } }));
    const text = onboardEl(el).textContent ?? "";
    expect(onboardEl(el).style.display).toBe("block");
    expect(text).toMatch(/Topping up · 3 of 9/);
    expect(text).not.toContain("One-time setup"); // a ten-minute player is not a first-timer
    expect(text).toContain("hand it back");       // the refill's own words for `undelegate`
    expect(text).toContain("you can bet again next market");
    // same rule as setup: the sequence is the progress, the clock is not ours to promise
    expect(text).not.toMatch(/second|minute|~|\d+s\b/i);
    panel.dispose();
  });

  it("says a stopped top-up is a top-up, not a setup", () => {
    const { el, panel } = mount();
    panel.render(ctx({
      onboarding: { kind: "refill", step: null, index: 0, of: 9, error: "Your wallet needs about 0.01 SOL for fees.", betError: null },
    }));
    expect(onboardEl(el).className).toContain("stopped");
    expect(onboardEl(el).textContent).toContain("Top-up stopped");
    expect(onboardEl(el).textContent).not.toContain("Setup stopped");
    panel.dispose();
  });

  it("renders a bet error as its own note without hiding refill progress", () => {
    const { el, panel } = mount();
    panel.render(ctx({
      onboarding: {
        kind: "refill", step: "deposit", index: 7, of: 9, error: null,
        betError: "Betting just closed for this race — the next market opens in about 46 seconds.",
      },
    }));
    // the refill is what explains the refusal — a failed tap must never be what erases it
    expect(onboardEl(el).style.display).toBe("block");
    expect(onboardEl(el).textContent).toContain("Topping up · 7 of 9");
    expect(betErrEl(el).style.display).toBe("block");
    expect(betErrEl(el).className).toContain("stopped");
    expect(betErrEl(el).textContent).toContain("Bet not placed");
    expect(betErrEl(el).textContent).toContain("Betting just closed for this race");
    panel.dispose();
  });

  it("says nothing about a bet that was never refused", () => {
    const { el, panel } = mount();
    panel.render(ctx());
    expect(betErrEl(el).style.display).toBe("none");
    panel.render(ctx({ onboarding: { kind: "refill", step: "wrap", index: 6, of: 9, error: null, betError: null } }));
    expect(betErrEl(el).style.display).toBe("none");
    panel.dispose();
  });

  it("still greys every row while the bet the onboarding is for is in flight", () => {
    const { el, panel } = mount();
    // fundable on purpose: the gate is open, so the in-flight send is the only thing greying these
    panel.render(ctx({ wallet: 100, betable: 20, pendingCar: 2, onboarding: { kind: "setup", step: "join", index: 1, of: 5, error: null, betError: null } }));
    const btns = betButtons(el);
    expect(btns.every((b) => b.disabled)).toBe(true);
    expect(btns[2].textContent).toBe("···");           // the same amber in-flight beat as any other bet
    expect(btns[2].classList.contains("pending")).toBe(true);
    panel.dispose();
  });
});

describe("betPanel claim window", () => {
  const claimEl = (el: HTMLElement) => el.querySelector(".bp-claim") as HTMLElement;

  it("shows nothing when the book reports nothing to collect", () => {
    const { el, panel } = mount();
    panel.render(ctx());
    expect(claimEl(el).style.display).toBe("none");
    panel.dispose();
  });

  it("names the amount, the race and how much of the window is left", () => {
    const { el, panel } = mount();
    panel.render(ctx({ claim: { raceSeq: 40, amount: 3.2, racesLeft: 27, windowRaces: 32, expired: false } }));
    const text = claimEl(el).textContent ?? "";
    expect(claimEl(el).style.display).toBe("block");
    expect(text).toContain("$3.20 to collect");
    expect(text).toContain("race #40");
    expect(text).toContain("27 of 32 races left");
    expect(text).toContain("Your next bet collects it"); // place_bet auto-settles a stale ticket
    expect(claimEl(el).className).not.toContain("warn");
    panel.dispose();
  });

  it("reads as a warning once the window is nearly out", () => {
    const { el, panel } = mount();
    panel.render(ctx({ claim: { raceSeq: 40, amount: 3.2, racesLeft: 4, windowRaces: 32, expired: false } }));
    expect(claimEl(el).className).toContain("warn");
    expect(claimEl(el).textContent).toContain("Claim window closing — 4 of 32 races left");
    panel.dispose();
  });

  it("says plainly that an aged-out ticket can no longer pay, and never quotes an amount for it", () => {
    const { el, panel } = mount();
    panel.render(ctx({ claim: { raceSeq: 7, amount: 0, racesLeft: 0, windowRaces: 32, expired: true } }));
    const text = claimEl(el).textContent ?? "";
    expect(claimEl(el).className).toContain("gone");
    expect(text).toContain("Race #7 can no longer pay");
    expect(text).toContain("Past the 32-race claim window");
    expect(text).not.toContain("$"); // the result that priced the stakes is the thing that is gone
    panel.dispose();
  });
});

describe("betPanel FINISH card", () => {
  it("paints the settled winner, the payout multiple, the net and the live wallet", () => {
    const { el, panel } = mount();
    panel.render(ctx({
      phase: "FINISH",
      settle: { winnerId: 2, net: 12.5, winnerMult: 3.4, walletAfter: 112.5 },
      wallet: 112.5,
    }));
    const text = el.textContent ?? "";
    expect(text).toContain("Trabant WINS");
    expect(text).toContain("market paid x3.40");
    expect(text).toContain("+$12.50");
    expect(text).toContain("Wallet: $112.50");
    expect((el.querySelector(".bp-net") as HTMLElement).className).toContain("up");
    panel.dispose();
  });

  it("shows a loss in the down style", () => {
    const { el, panel } = mount();
    panel.render(ctx({ phase: "FINISH", settle: { winnerId: 0, net: -5, winnerMult: 1.6, walletAfter: 95 } }));
    expect(el.textContent).toContain("−$5.00");
    expect((el.querySelector(".bp-net") as HTMLElement).className).toContain("down");
    panel.dispose();
  });

  it("shows the non-bet credit line (the owner-podium slice) beside the result", () => {
    const { el, panel } = mount();
    const creditEl = el.querySelector(".bp-credit") as HTMLElement;
    panel.render(ctx({ phase: "FINISH", settle: { winnerId: 0, net: 0, winnerMult: 1, walletAfter: 100 } }));
    expect(creditEl.style.display).toBe("none"); // nothing credited → the line stays hidden

    panel.render(ctx({
      phase: "FINISH",
      settle: { winnerId: 0, net: 0, winnerMult: 1, walletAfter: 102.5 },
      credit: "Podium — P1: +$2.50",
      wallet: 102.5,
    }));
    expect(el.textContent).toContain("Podium — P1: +$2.50");
    expect(creditEl.style.display).toBe("block");
    panel.dispose();
  });
});

describe("betPanel phase visibility", () => {
  it("shows the market panel only while open, the strip while running, the card at the finish", () => {
    const { el, panel } = mount();
    const panelEl = el.querySelector(".bp-panel") as HTMLElement;
    const stripEl = el.querySelector(".bp-strip") as HTMLElement;
    const settleEl = el.querySelector(".bp-settle") as HTMLElement;

    panel.render(ctx({ phase: "MARKET" }));
    expect([panelEl.style.display, stripEl.style.display, settleEl.style.display]).toEqual(["block", "none", "none"]);

    panel.render(ctx({ phase: "RACING", stakes: [5, 0, 0], raceLeaderName: "DeLorean" }));
    expect([panelEl.style.display, stripEl.style.display, settleEl.style.display]).toEqual(["none", "flex", "none"]);
    expect(stripEl.textContent).toContain("$5 Bedrock");
    expect(stripEl.textContent).toContain("LEADING DeLorean");

    panel.render(ctx({ phase: "FINISH" }));
    expect([panelEl.style.display, stripEl.style.display, settleEl.style.display]).toEqual(["none", "none", "block"]);
    panel.dispose();
  });

  it("says so plainly when the player sat the race out", () => {
    const { el, panel } = mount();
    panel.render(ctx({ phase: "RACING" }));
    expect((el.querySelector(".bp-strip") as HTMLElement).textContent).toContain("no bet placed");
    panel.dispose();
  });
});
