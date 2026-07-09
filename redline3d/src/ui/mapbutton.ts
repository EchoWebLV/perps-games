export interface MapButton {
  el: HTMLButtonElement;
  setVisible(visible: boolean): void;
}

// home-base glyph (roof + walls + door) — "back to the lobby" reads instantly, neon line
// style consistent with the carpicker icons. Replaced the old map-pin (too generic).
const HOME_SVG =
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.6V20h13V9.6"/><path d="M10 20v-5.5h4V20"/></svg>`;

// soft continuous cyan glow. Injected once (module-guarded) so many mounts share one <style>.
let injected = false;
function injectPulse(): void {
  if (injected) return;
  if (typeof document === "undefined" || !document.head) return; // headless/test DOM stub — skip
  const style = document.createElement("style");
  style.textContent =
    `@keyframes mapBtnPulse{` +
    `0%,100%{box-shadow:0 0 0 1px rgba(39,231,255,.35),0 0 12px rgba(39,231,255,.32),inset 0 0 9px rgba(39,231,255,.10)}` +
    `50%{box-shadow:0 0 0 1px rgba(39,231,255,.65),0 0 22px rgba(39,231,255,.60),inset 0 0 13px rgba(39,231,255,.22)}}`;
  document.head.appendChild(style);
  injected = true;
}

/** The classic compact icon button left of the menu — a glowing home glyph; opens the lobby. */
export function createMapButton(parent: HTMLElement, onClick: () => void): MapButton {
  injectPulse();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe"; // pointer-events:auto under #hud; the button styles itself inline below
  btn.setAttribute("aria-label", "Open garage lobby");
  btn.innerHTML = HOME_SVG;
  btn.style.cssText = [
    "position:absolute",
    "top:144px", // same row, directly left of the menu button (the original slot)
    "right:max(62px,calc(env(safe-area-inset-right) + 50px))",
    "z-index:8",
    "width:42px", "height:42px", "padding:0", // the original 42×42 icon square
    "display:grid", "place-items:center",
    "border:1.5px solid var(--cyan)", // bright cyan glowing rim — noticeable, unlike the old flat panel
    "border-radius:11px", "cursor:pointer",
    "background:rgba(12,10,26,.9)", // opaque so it pops off the 3D scene
    "color:var(--cyan)",
    "animation:mapBtnPulse 2.4s ease-in-out infinite",
  ].join(";");
  btn.onclick = onClick;
  parent.appendChild(btn);

  return {
    el: btn,
    setVisible(visible) { btn.style.display = visible ? "grid" : "none"; },
  };
}
