// Scrap Yard economics — what melting a spare copy is worth. Reuses the crate duplicate scale
// (core/crate.ts) so a melted spare pays exactly what an auto-scrapped dupe used to. Pure.
import { dupeScrap } from "./crate";

/** scrap paid for melting ONE spare copy of a car of the given rarity */
export const meltValue = (rarity?: number): number => dupeScrap(rarity);

/** total scrap from melting every spare in a set (spares = copies above the kept floor of 1) */
export function meltAllValue(items: { rarity?: number; spares: number }[]): number {
  return items.reduce((sum, it) => sum + meltValue(it.rarity) * Math.max(0, it.spares), 0);
}
