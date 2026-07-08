/**
 * Race-level skins. Each WorldTheme is a self-contained descriptor of everything a level shows —
 * sky, celestial body, stars, horizon scenery, the neon grid/road, AND the lights (lamp colours +
 * the point-lights that catch the car). `world.ts` builds the race world from one of these and
 * `setTheme(key)` swaps to another; the crate-reward system will later call the same setter.
 *
 * New skins are added here (a data descriptor) + a scenery/celestial builder in world.ts, one by one.
 */
export type SceneryKind = "mountains" | "city" | "mesa" | "ice" | "volcano";
export type CelestialKind = "slicedSun" | "moon" | "eclipse";
export type LampStyle = "arm" | "cityDouble" | "utility" | "crystal" | "brazier" | "deco";

export interface WorldTheme {
  key: string;
  name: string;
  /** sky dome gradient [top, bottom(horizon)] */
  sky: [string, string];
  celestial: CelestialKind;
  /** 3-stop gradient / disc tints for the celestial body [hi, mid, lo] */
  celestialColors: [string, string, string];
  star: string;
  scenery: SceneryKind;
  /** horizon scenery palette — base (dark foot), peak (top), rim (silhouette glow), accent (windows/lava) */
  sceneryColors: { base: string; peak: string; rim: string; accent: string };
  /** neon floor grid [colourA(right), colourB(left)] */
  grid: [string, string];
  /** road-edge neon */
  roadEdge: string;
  /** lamp + car point-light colours [left, right] — the whole level relights from these */
  lights: [string, string];
  /** the roadside street-lamp fixture design for this level */
  lampStyle: LampStyle;
  /** ice: add drifting aurora curtains to the sky */
  aurora?: boolean;
}

export const DEFAULT_KEY = "synthwave";
const STORAGE_KEY = "raider.raceSkin";

export const THEMES: WorldTheme[] = [
  {
    key: "synthwave",
    name: "Synthwave Sunset",
    sky: ["#160a2e", "#7a1d5e"],
    celestial: "slicedSun",
    celestialColors: ["#fff27a", "#ff7a3c", "#ff2d9a"],
    star: "#cfe0ff",
    scenery: "mountains",
    sceneryColors: { base: "#120620", peak: "#5d1c44", rim: "#c64f9e", accent: "#c64f9e" },
    grid: ["#ff39c0", "#27e7ff"],
    roadEdge: "#ff39c0",
    lights: ["#27e7ff", "#ff39c0"],
    lampStyle: "arm",
  },
  {
    key: "neon-city",
    name: "Neon City",
    sky: ["#050a24", "#123a6a"],
    celestial: "moon",
    celestialColors: ["#eaf2ff", "#9fc0ee", "#5a74a8"],
    star: "#bcd4ff",
    scenery: "city",
    sceneryColors: { base: "#0a1230", peak: "#1a2a55", rim: "#3a6ad0", accent: "#7fe3ff" },
    grid: ["#ff39c0", "#27e7ff"],
    roadEdge: "#27e7ff",
    lights: ["#27e7ff", "#cfe9ff"],
    lampStyle: "cityDouble",
  },
  {
    key: "desert",
    name: "Desert Canyon",
    sky: ["#2a1030", "#ff7a3c"],
    celestial: "slicedSun",
    celestialColors: ["#ffe6a0", "#ff9a3d", "#ff5a2a"],
    star: "#ffdca8",
    scenery: "mesa",
    sceneryColors: { base: "#2a1410", peak: "#7a3a22", rim: "#ff9a4d", accent: "#ff7a3c" },
    grid: ["#ff8a3d", "#ffd27a"],
    roadEdge: "#ff9a4d",
    lights: ["#ffb020", "#ff7a2a"],
    lampStyle: "utility",
  },
  {
    key: "ice",
    name: "Ice Aurora",
    sky: ["#03101c", "#0e3a44"],
    celestial: "moon",
    celestialColors: ["#eaf6ff", "#bcd8e8", "#7a9ab0"],
    star: "#dff0ff",
    scenery: "ice",
    sceneryColors: { base: "#0a2430", peak: "#2a6a80", rim: "#8fe8ff", accent: "#bfefff" },
    grid: ["#7fe8ff", "#eafcff"],
    roadEdge: "#7fe8ff",
    lights: ["#7fe8ff", "#b6ffe0"],
    lampStyle: "crystal",
    aurora: true,
  },
  {
    key: "volcano",
    name: "Volcanic Inferno",
    sky: ["#12040a", "#5e0f16"],
    celestial: "eclipse",
    celestialColors: ["#ff5a2a", "#ffb020", "#2a0606"],
    star: "#ff9a6a",
    scenery: "volcano",
    sceneryColors: { base: "#180606", peak: "#3a1210", rim: "#ff6a1a", accent: "#ff7a1a" },
    grid: ["#ff5a1a", "#ffd24a"],
    roadEdge: "#ff6a1a",
    lights: ["#ff7a2a", "#ff2a1a"],
    lampStyle: "brazier",
  },
  {
    key: "miami",
    name: "Miami Sunset",
    sky: ["#241a72", "#ff5fa2"],
    celestial: "slicedSun",
    celestialColors: ["#fff0cf", "#ff9ad6", "#ff3d9e"],
    star: "#ffd9f0",
    scenery: "city",
    sceneryColors: { base: "#2a1a4a", peak: "#5a2f7a", rim: "#ff7ad0", accent: "#8fe6ff" },
    grid: ["#ff5fc0", "#27e7ff"],
    roadEdge: "#ff5fc0",
    lights: ["#27e7ff", "#ff5fc0"],
    lampStyle: "deco",
  },
];

export function themeKeys(): string[] {
  return THEMES.map((t) => t.key);
}

export function isThemeKey(key: string | null | undefined): boolean {
  return THEMES.some((t) => t.key === key);
}

/** the theme for a key, or the default when the key is unknown */
export function getTheme(key: string | null | undefined): WorldTheme {
  return THEMES.find((t) => t.key === key) ?? THEMES.find((t) => t.key === DEFAULT_KEY)!;
}

/** the next key in registration order, wrapping; an unknown key resolves to the first */
export function nextThemeKey(key: string): string {
  const keys = themeKeys();
  const i = keys.indexOf(key);
  return keys[(i + 1) % keys.length];
}

/** a valid stored key, or the default */
export function resolveThemeKey(stored: string | null | undefined): string {
  return isThemeKey(stored) ? (stored as string) : DEFAULT_KEY;
}

/** persisted active skin (dev switcher now; crate reward later) */
export function loadThemeKey(): string {
  try { return resolveThemeKey(localStorage.getItem(STORAGE_KEY)); } catch { return DEFAULT_KEY; }
}

export function saveThemeKey(key: string): void {
  try { localStorage.setItem(STORAGE_KEY, resolveThemeKey(key)); } catch { /* private mode — non-fatal */ }
}
