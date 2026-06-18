export interface Radio {
  /** start playback if the user wants it on — call from a user gesture (autoplay) */
  resume(): void;
}

// Live synthwave stream (Nightride FM). NOTE: third-party copyrighted music —
// fine for dev/feel, but swap for a licensed / royalty-free source before any
// paid release. Ogg plays on Android (Seeker) + Chrome.
const STREAM = "https://stream.nightride.fm/nightride.ogg";

/** A muteable synthwave radio + a small toggle button stacked above the menu. */
export function createRadio(parent: HTMLElement): Radio {
  const audio = document.createElement("audio");
  audio.src = STREAM;
  audio.preload = "none";
  audio.volume = 0.42; // sit under the engine/stings
  parent.appendChild(audio);

  let want = true; // user intent to play

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe panel";
  btn.setAttribute("aria-label", "Toggle music");
  btn.style.cssText = [
    "position:absolute",
    "top:calc(50% - 71px)", // 50px above the menu hamburger
    "right:max(12px,env(safe-area-inset-right))",
    "z-index:8",
    "width:42px", "height:42px", "padding:0",
    "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer",
    "background:rgba(12,10,26,.74)",
    "font:700 19px/1 'Chakra Petch',ui-monospace,monospace",
  ].join(";");

  const render = () => {
    btn.textContent = "♫";
    btn.style.color = want ? "var(--cyan)" : "var(--mut)";
    btn.style.textShadow = want ? "0 0 10px rgba(39,231,255,.75)" : "none";
    btn.style.opacity = want ? "1" : "0.5";
  };
  btn.onclick = () => {
    want = !want;
    if (want) void audio.play().catch(() => {});
    else audio.pause();
    render();
  };
  render();
  parent.appendChild(btn);

  return {
    resume() { if (want) void audio.play().catch(() => {}); },
  };
}
