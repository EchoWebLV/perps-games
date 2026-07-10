// Persisted audio volumes (Music / SFX), 0..1. Durable localStorage flags in the same idiom as
// welcome.ts / howto.ts, so a reload restores the player's fader positions. Pure read/write so the
// migration + clamping are unit-tested without a browser.

import { browserStore, type KvStore } from "./identity";

export const MUSIC_VOL_KEY = "raider.vol.music.v1";
export const SFX_VOL_KEY = "raider.vol.sfx.v1";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Read a persisted 0..1 volume. `fallback` is used when unset or corrupt. A legacy on/off boolean
 *  (the audio toggles were on/off before faders) migrates: true/on → 1, false/off → 0. */
export function readVolume(key: string, fallback: number, store: KvStore = browserStore): number {
  const raw = store.get(key);
  if (raw === null) return clamp01(fallback);
  if (raw === "true" || raw === "on") return 1;   // legacy boolean → full
  if (raw === "false" || raw === "off") return 0;  // legacy boolean → off
  const n = Number(raw);
  return Number.isFinite(n) ? clamp01(n) : clamp01(fallback);
}

/** Persist a 0..1 volume (clamped). */
export function writeVolume(key: string, v: number, store: KvStore = browserStore): void {
  store.set(key, String(clamp01(v)));
}
