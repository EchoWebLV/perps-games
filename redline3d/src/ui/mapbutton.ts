import { onTap } from "./tap";

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

/** Side home control — the main lobby chrome that returns to the Slopwheels hub. */
export function createMapButton(parent: HTMLElement, onClick: () => void): MapButton {
  injectPulse();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe"; // pointer-events:auto under #hud; the button styles itself inline below
  btn.setAttribute("aria-label", "Back to hub");
  btn.innerHTML = HOME_SVG;
  btn.style.cssText = [
    "position:absolute",
    // right rail, under LIVE — where the emoji emotes sat. Hamburger stays below this.
    "top:calc(max(10px,env(safe-area-inset-top)) + 50px)",
    "right:max(12px,env(safe-area-inset-right))",
    "z-index:8",
    "width:48px", "height:48px", "padding:0",
    "display:grid", "place-items:center",
    "border:1.5px solid var(--cyan)",
    "border-radius:12px", "cursor:pointer",
    "background:rgba(12,10,26,.9)",
    "color:var(--cyan)",
    "animation:mapBtnPulse 2.4s ease-in-out infinite",
  ].join(";");
  onTap(btn, onClick);
  parent.appendChild(btn);

  return {
    el: btn,
    setVisible(visible) { btn.style.display = visible ? "grid" : "none"; },
  };
}
