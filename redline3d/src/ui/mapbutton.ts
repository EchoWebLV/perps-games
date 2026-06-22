export interface MapButton {
  el: HTMLButtonElement;
  setVisible(visible: boolean): void;
}

// map-pin glyph, neon line style consistent with the carpicker icons
const MAP_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>`;

/** A map-pin button directly left of the menu button; opens the parking-lot lobby. */
export function createMapButton(parent: HTMLElement, onClick: () => void): MapButton {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe panel";
  btn.setAttribute("aria-label", "Open garage lobby");
  btn.innerHTML = MAP_SVG;
  btn.style.cssText = [
    "position:absolute",
    "top:144px", // same row, directly left of the menu button (reuses the old music-button slot)
    "right:max(62px,calc(env(safe-area-inset-right) + 50px))",
    "z-index:8",
    "width:42px", "height:42px", "padding:0",
    "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer",
    "background:rgba(12,10,26,.74)",
    "color:var(--cyan)",
  ].join(";");
  btn.onclick = onClick;
  parent.appendChild(btn);

  return {
    el: btn,
    setVisible(visible) { btn.style.display = visible ? "grid" : "none"; },
  };
}
