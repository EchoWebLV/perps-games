import { describe, expect, it } from "vitest";
import { readVolume, writeVolume, MUSIC_VOL_KEY, SFX_VOL_KEY } from "./audio-prefs";
import type { KvStore } from "./identity";

// in-memory KvStore stand-in (no browser)
const fakeStore = (seed: Record<string, string> = {}): KvStore & { data: Record<string, string> } => {
  const data = { ...seed };
  return { data, get: (k) => (k in data ? data[k] : null), set: (k, v) => { data[k] = v; } };
};

describe("audio-prefs volume persistence", () => {
  it("returns the fallback when unset (fresh player)", () => {
    const store = fakeStore();
    expect(readVolume(SFX_VOL_KEY, 1, store)).toBe(1);
    expect(readVolume(MUSIC_VOL_KEY, 0, store)).toBe(0); // dev boot default
  });

  it("reads a persisted 0..1 value", () => {
    const store = fakeStore({ [SFX_VOL_KEY]: "0.5" });
    expect(readVolume(SFX_VOL_KEY, 1, store)).toBe(0.5);
  });

  it("migrates a legacy on/off boolean → 0 or 1", () => {
    expect(readVolume(SFX_VOL_KEY, 1, fakeStore({ [SFX_VOL_KEY]: "true" }))).toBe(1);
    expect(readVolume(SFX_VOL_KEY, 1, fakeStore({ [SFX_VOL_KEY]: "false" }))).toBe(0);
    expect(readVolume(MUSIC_VOL_KEY, 1, fakeStore({ [MUSIC_VOL_KEY]: "on" }))).toBe(1);
    expect(readVolume(MUSIC_VOL_KEY, 1, fakeStore({ [MUSIC_VOL_KEY]: "off" }))).toBe(0);
  });

  it("falls back on a corrupt value", () => {
    expect(readVolume(SFX_VOL_KEY, 0.7, fakeStore({ [SFX_VOL_KEY]: "banana" }))).toBe(0.7);
  });

  it("clamps out-of-range reads and writes into 0..1", () => {
    expect(readVolume(SFX_VOL_KEY, 1, fakeStore({ [SFX_VOL_KEY]: "5" }))).toBe(1);
    expect(readVolume(SFX_VOL_KEY, 1, fakeStore({ [SFX_VOL_KEY]: "-3" }))).toBe(0);
    const store = fakeStore();
    writeVolume(SFX_VOL_KEY, 1.8, store);
    expect(store.data[SFX_VOL_KEY]).toBe("1");
    writeVolume(MUSIC_VOL_KEY, -1, store);
    expect(store.data[MUSIC_VOL_KEY]).toBe("0");
  });

  it("round-trips a written value", () => {
    const store = fakeStore();
    writeVolume(MUSIC_VOL_KEY, 0.42, store);
    expect(readVolume(MUSIC_VOL_KEY, 1, store)).toBe(0.42);
  });
});
