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
// paid release. Ogg plays on Android (Seeker) + Chrome.
const STREAM = "https://stream.nightride.fm/nightride.ogg";

/** A muteable synthwave radio. The on/off toggle lives in the menu (see carpicker). */
export function createRadio(parent: HTMLElement): Radio {
  const audio = document.createElement("audio");
  audio.src = STREAM;
  audio.preload = "none";
  audio.volume = 0.42; // sit under the engine/stings
  parent.appendChild(audio);

  let want = true; // user intent to play

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
