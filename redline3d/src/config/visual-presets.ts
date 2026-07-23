// Canonical visual presets — the SINGLE source of truth for every tunable lighting/look default.
// Modules read their shipped defaults from here (static import → bundled, works in prod, no fetch)
// instead of hardcoding literals. The DEV Light Lab (ui/light-lab.ts) edits these live and its
// SAVE ALL writes this exact JSON back to the repo via a dev-only Vite endpoint, so a tuned look
// becomes the committed default.
//
// Colors are "#rrggbb" hex strings (THREE.Color/light constructors accept them directly). Everything
// else is a plain number, except Global.edgePass which is a boolean. Keys are grouped by scene name
// (matching the Light Lab folder names); "Global" holds the engine-wide toon knobs.
import raw from "./visual-presets.json";

export type PresetValue = number | boolean | string;
export type Presets = Record<string, Record<string, PresetValue>>;

export const PRESETS: Presets = raw as Presets;

/** number preset with a compile-time fallback (used if a key is ever missing/typo'd) */
export function pNum(scene: string, key: string, fallback: number): number {
  const v = PRESETS[scene]?.[key];
  return typeof v === "number" ? v : fallback;
}
/** "#rrggbb" hex-string preset with a fallback (THREE accepts the string directly) */
export function pColor(scene: string, key: string, fallback: string): string {
  const v = PRESETS[scene]?.[key];
  return typeof v === "string" ? v : fallback;
}
/** boolean preset with a fallback */
export function pBool(scene: string, key: string, fallback: boolean): boolean {
  const v = PRESETS[scene]?.[key];
  return typeof v === "boolean" ? v : fallback;
}
