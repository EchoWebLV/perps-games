export interface Radio {
  /** start playback if the user wants it on — call from a user gesture (autoplay) */
  resume(): void;
  /** is the music currently switched on (user intent)? */
  isOn(): boolean;
  /** switch music on/off — call from a user gesture so play() isn't blocked */
  setOn(on: boolean): void;
}

// Live synthwave stream (Nightride FM). NOTE: third-party copyrighted music —
// fine for dev/feel, but swap for a licensed / royalty-free source before any
// paid release.
//
// Format matters: Nightride serves the same station as MP3 (audio/mpeg, 320k)
// and Ogg/Opus (application/ogg) — verified live. iOS Safari CANNOT decode
// Ogg/Opus, so the old .ogg-only src left iPhones silent (the play() rejection
// is swallowed). MP3 decodes everywhere (iOS + Android/Seeker + Chrome), so we
// prefer it and keep Ogg as a fallback. There is no AAC/M4A/HLS endpoint for
// this station (probed — all 404), so those aren't offered. Ordered best-first;
// pickStreamSource() feature-detects the first the browser reports it can play.
export interface StreamSource {
  url: string;
  mime: string;
}
export const STREAM_SOURCES: StreamSource[] = [
  { url: "https://stream.nightride.fm/nightride.mp3", mime: "audio/mpeg" },
  { url: "https://stream.nightride.fm/nightride.ogg", mime: 'audio/ogg; codecs="opus"' },
];

/**
 * Pick the first stream the browser reports it can decode. `canPlayType` is
 * `HTMLMediaElement.canPlayType` — "probably"/"maybe" means playable, "" not.
 * Returns null when nothing is decodable (caller then leaves src unset — the
 * existing swallowed-play() path, no crash).
 */
export function pickStreamSource(
  canPlayType: (mime: string) => string,
): StreamSource | null {
  for (const source of STREAM_SOURCES) {
    if (canPlayType(source.mime) !== "") return source;
  }
  return null;
}

/** A muteable synthwave radio. The on/off toggle lives in the menu (see carpicker). */
export function createRadio(parent: HTMLElement, startOn = true): Radio {
  const audio = document.createElement("audio");
  // Feature-detect a decodable format (iOS can't play Ogg/Opus) before setting
  // src. null → leave src unset; play() then rejects and is swallowed as today.
  const source = pickStreamSource((mime) => audio.canPlayType(mime));
  if (source) audio.src = source.url;
  audio.preload = "none";
  audio.volume = 0.42; // sit under the engine/stings
  parent.appendChild(audio);

  let want = startOn; // user intent to play

  return {
    resume() { if (want) void audio.play().catch(() => {}); },
    isOn: () => want,
    setOn(on) {
      want = on;
      if (on) void audio.play().catch(() => {});
      else audio.pause();
    },
  };
}
