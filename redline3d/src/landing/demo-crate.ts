// The landing page's "Crack one open" demo. Any visitor cracks a crate with the REAL tier odds and
// the SAME cinematic the game uses — no sign-in, nothing persists. To keep the marketing bundle free
// of three.js and game code, this module imports ONLY the DOM-free odds core (core/crate, core/rarity)
// and the shared cinematic (ui/crate-cinematic) — never three, main, or any game module (test-enforced).

import { rollCrate } from "../core/crate";
import { TIERS, tierOf, type Rarity } from "../core/rarity";
import { createCrateCinematic, type CrateCinematicRun } from "../ui/crate-cinematic";

export interface DemoCar { name: string; rarity: number; card: string }

// Mirrors the PULLABLE CAR_DEFS roster (name + rarity, test-enforced against src/main.ts). `card`
// points at a baked card in public/cards/. Non-pullable cars (Skull, Slot Machine, Cook Wagon,
// Solana Paper) are intentionally absent — they can't drop, so they must not be crackable here.
export const DEMO_CARS: DemoCar[] = [
  { name: "DeLorean", rarity: 4, card: "/cards/delorean.png" },
  { name: "Cybertruck", rarity: 3, card: "/cards/cybertruck.png" },
  { name: "Orion", rarity: 5, card: "/cards/orion.png" },
  { name: "Vaporwave", rarity: 3, card: "/cards/vaporwave.png" },
  { name: "Bedrock", rarity: 5, card: "/cards/bedrock.png" },
  { name: "Clown Car", rarity: 5, card: "/cards/clown-car.png" },
  { name: "Cart Rod", rarity: 3, card: "/cards/cart-rod.png" },
  { name: "Magnet", rarity: 3, card: "/cards/magnet.png" },
  { name: "Helmet", rarity: 4, card: "/cards/helmet.png" },
  { name: "Pink Rod", rarity: 4, card: "/cards/pink-rod.png" },
  { name: "Six Wheeler", rarity: 4, card: "/cards/six-wheeler.png" },
  { name: "Banana", rarity: 1, card: "/cards/banana.png" },
  { name: "Big Frank", rarity: 1, card: "/cards/big-frank.png" },
  { name: "Dragon", rarity: 1, card: "/cards/dragon.png" },
  { name: "Homewrecker", rarity: 1, card: "/cards/homewrecker.png" },
  { name: "Copycat", rarity: 3, card: "/cards/copycat.png" },
  { name: "Knockout", rarity: 3, card: "/cards/knockout.png" },
  { name: "Prickle", rarity: 2, card: "/cards/prickle.png" },
  { name: "The Kraken", rarity: 2, card: "/cards/the-kraken.png" },
  { name: "Noodler", rarity: 2, card: "/cards/noodler.png" },
];

// Fair-crate odds derived straight from the rarity table (50/28/14/6/2) so the demo can never drift
// from the real curve. Keyed by tier id → weight, matching rollCrate's tierWeights parameter.
const FAIR_WEIGHTS: Partial<Record<Rarity, number>> = Object.fromEntries(
  TIERS.map((tier): [Rarity, number] => [tier.id, tier.weight]),
);

/** Roll a demo car with the real tier odds — a pure passthrough to the game's rollCrate. */
export const rollDemo = (rTier: number, rCar: number): DemoCar | null =>
  rollCrate(DEMO_CARS, FAIR_WEIGHTS, rTier, rCar);

// The pause before the rip: must stay > the cinematic's 500ms drop-in phase so the crate settles and
// the shake breathes before it bursts open. (The reveal escalation adds SHAKE_EXTRA_MS on top.)
const PRE_REVEAL_MS = 900;

export function initDemoCrate(): void {
  const mount = document.querySelector<HTMLElement>("[data-demo-crate]");
  if (!mount) return;
  const button = mount.querySelector<HTMLButtonElement>("[data-demo-open]");
  if (!button) return;

  // The live run, closed over by onDone so "Crack another" (the Done button) tears the overlay down
  // and returns the visitor to the section — abort() is idempotent, so repeat activations are safe.
  // Focus returns to the trigger so keyboard/SR users aren't dropped onto <body> when it closes.
  let run: CrateCinematicRun | null = null;
  const cx = createCrateCinematic({ onDone: () => { run?.abort(); button.focus(); } });
  // Portal the (position:fixed, z-index 10000) overlay to <body>, NOT under #crack: mounting it
  // inside <main> (position:relative; z-index:1) would trap it in main's stacking context, letting
  // the fixed .site-header (z-index:30) paint over the "full-screen" opening.
  document.body.appendChild(cx.el);

  button.addEventListener("click", () => {
    const car = rollDemo(Math.random(), Math.random());
    if (!car) return;
    const tier = tierOf(car.rarity);
    run = cx.open({ crateColor: tier.color });
    const active = run; // captured: a superseded run's reveal() is a safe no-op (see cinematic)
    // Let the drop + shake breathe before the rip, then flip the card the visitor pulled.
    window.setTimeout(() => active.reveal({
      rarity: car.rarity,
      chips: [{ label: tier.name, color: tier.color }],
      doneLabel: "Crack another",
      onCardSlot: (slot) => {
        slot.innerHTML =
          `<div class="demo-card">` +
            `<img class="demo-card-art" src="${car.card}" alt="${car.name} card" />` +
            `<b class="demo-card-name" style="--tc:${tier.color}">${car.name}</b>` +
            `<a class="launch-button demo-keep" href="/play/"><span>Play to keep what you pull</span><b aria-hidden="true">GO!</b></a>` +
          `</div>`;
      },
    }), PRE_REVEAL_MS);
  });
}
