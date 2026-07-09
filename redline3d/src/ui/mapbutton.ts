export interface MapButton {
  el: HTMLButtonElement;
  setVisible(visible: boolean): void;
}

// bold Chakra Petch wordmark — text-only (no icon), reads as "tap here to leave"
const LABEL_SPAN =
  `<span style="font-family:'Chakra Petch',ui-monospace,monospace;font-weight:700;font-size:12px;letter-spacing:.16em;line-height:1;white-space:nowrap">LOBBY</span>`;

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

/** A compact glowing text-only "LOBBY" pill in the top-right; opens the parking-lot lobby. */
export function createMapButton(parent: HTMLElement, onClick: () => void): MapButton {
  injectPulse();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe"; // pointer-events:auto under #hud; the pill styles itself inline below
  btn.setAttribute("aria-label", "Open garage lobby");
  btn.innerHTML = LABEL_SPAN;
  btn.style.cssText = [
    "position:absolute",
    "top:144px", // same row as the menu button…
    "right:max(62px,calc(env(safe-area-inset-right) + 50px))", // …anchored right, grows LEFT so it clears the hamburger
    "z-index:8",
    "height:30px", "padding:0 12px", // compact pill — icon removed, text only
    "display:inline-flex", "align-items:center",
    "white-space:nowrap",
    "border:1.5px solid var(--cyan)", // bright cyan glowing rim
    "border-radius:999px", "cursor:pointer",
    "background:rgba(12,10,26,.9)", // opaque so it pops off the 3D scene
    "color:var(--cyan)",
    "animation:mapBtnPulse 2.4s ease-in-out infinite",
  ].join(";");
  btn.onclick = onClick;
  parent.appendChild(btn);

  return {
    el: btn,
    setVisible(visible) { btn.style.display = visible ? "inline-flex" : "none"; },
  };
}
