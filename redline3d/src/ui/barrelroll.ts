import { onTap } from "./tap";

export interface BarrelRoll {
  /** show the button only for the car that has the ability */
  setEnabled(on: boolean): void;
  /** re-assert visibility each frame + re-arm the single use when the round ends */
  update(live: boolean): void;
}
export type BarrelPhase = "ready" | "used";

/**
 * Pure state for the Helmet's "Barrel Roll" — a manual, once-per-round flip button
 * (nitro-style, but a single use and no cooldown). Firing flips the trade direction
 * and spins the whole world; main.ts wires the actual effect. No DOM, unit-testable.
 */
export function createBarrelRollCore() {
  let enabled = false, live = false, used = false;
  return {
    get used() { return used; },
    get phase(): BarrelPhase { return used ? "used" : "ready"; },
    /** the button shows only when the car has the ability AND a round is live */
    get visible() { return enabled && live; },
    setEnabled(on: boolean) { enabled = on; if (!on) used = false; },
    /** request the flip; true only if it engaged (enabled + live + unused) */
    fire(): boolean {
      if (enabled && live && !used) { used = true; return true; }
      return false;
    },
    update(isLive: boolean) {
      if (!isLive && live) used = false; // round over → re-arm the single use
      live = isLive;
    },
  };
}

/**
 * Helmet's "Barrel Roll": tap to flip your bet LONG↔SHORT and spin the whole level a
 * full turn. A crimson twin-arrow button in the left thumb spot (nitro's slot), shown
 * only for the Helmet while a round is live; one use per round, then it reads USED.
 */
export function createBarrelRoll(parent: HTMLElement, onFire?: () => void): BarrelRoll {
  const core = createBarrelRollCore();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe";
  btn.setAttribute("aria-label", "Barrel Roll");
  btn.style.cssText = [
    "position:absolute",
    "left:max(14px,env(safe-area-inset-left))",
    "bottom:36%",
    "z-index:8",
    "width:66px", "height:66px", "padding:0",
    "display:none", "flex-direction:column", "align-items:center", "justify-content:center", "gap:1px",
    "border:2px solid rgba(255,64,96,.85)", "border-radius:50%", "cursor:pointer",
    "background:radial-gradient(circle at 50% 34%,rgba(255,92,120,.5),rgba(40,6,14,.92))",
    "color:#fff", "font:800 9px/1 'Chakra Petch',ui-monospace,monospace", "letter-spacing:.1em",
    "box-shadow:0 0 18px rgba(255,60,90,.6)", "transition:opacity .15s ease,transform .1s ease",
  ].join(";");
  // twin curved arrows chasing each other — a flip / roll glyph
  const glyph = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10a8 8 0 0 1 13.5-3.5L20 9"/><path d="M20 4v5h-5"/><path d="M20 14a8 8 0 0 1-13.5 3.5L4 15"/><path d="M4 20v-5h5"/></svg>';
  btn.innerHTML = `<span style="display:flex;filter:drop-shadow(0 0 5px rgba(255,80,110,.85))">${glyph}</span><span class="bl">FLIP</span>`;
  const labelEl = btn.querySelector(".bl") as HTMLElement;
  parent.appendChild(btn);

  const render = () => {
    const show = core.visible;
    btn.style.display = show ? "flex" : "none";
    if (!show) return;
    if (core.phase === "used") {
      btn.style.opacity = "0.35";
      btn.style.borderColor = "rgba(150,150,170,.6)";
      btn.style.boxShadow = "none";
      btn.style.transform = "scale(1)";
      labelEl.textContent = "USED";
    } else {
      btn.style.opacity = "1";
      btn.style.borderColor = "rgba(255,64,96,.85)";
      btn.style.boxShadow = "0 0 18px rgba(255,60,90,.6)";
      btn.style.transform = "scale(1)";
      labelEl.textContent = "FLIP";
    }
  };

  onTap(btn, () => { if (core.fire()) onFire?.(); render(); });

  return {
    setEnabled(on) { core.setEnabled(on); render(); },
    update(isLive) {
      core.update(isLive);
      render(); // re-assert visibility every frame — setHudMenuMode resets inline display on close
    },
  };
}
