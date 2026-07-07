// Cosmetic finishes bought at the Scrap Yard Paint Shop with scrap. `swatch` is both the UI dot
// and the color car.ts paints the model with. Pure catalog + pricing. Prices are starting points
// to tune in playtest (driving heaps + crate scrap are the primary funding; melt is supplementary).
import { tierOf } from "./rarity";

export interface Finish { id: string; name: string; swatch: string; }

export const FINISHES: readonly Finish[] = [
  { id: "gold",    name: "Golden Paint", swatch: "#ffcf5a" },
  { id: "crimson", name: "Crimson",      swatch: "#ff4d6d" },
  { id: "cyan",    name: "Cyber Cyan",   swatch: "#27e7ff" },
  { id: "violet",  name: "Ultraviolet",  swatch: "#b06bff" },
  { id: "mono",    name: "Gunmetal",     swatch: "#7b8494" },
];

export const finishById = (id: string): Finish | undefined => FINISHES.find((f) => f.id === id);

const BASE_PRICE: Readonly<Record<number, number>> = { 1: 120, 2: 200, 3: 350, 4: 600, 5: 1000 };

/** scrap to paint a car of the given rarity with `finishId`; Gold costs a premium */
export function paintPrice(rarity: number | undefined, finishId: string): number {
  const base = BASE_PRICE[tierOf(rarity).id];
  return finishId === "gold" ? Math.round(base * 1.5) : base;
}
