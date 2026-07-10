import { onTap } from "./tap";

export interface Flux {
  /** show the button only for the car that has the ability */
  setEnabled(on: boolean): void;
  /** advance timers + button visuals; true while the P&L freeze is active */
  update(dt: number, live: boolean): boolean;
}

export const FLUX_ACTIVE = 4;   // seconds frozen
export const FLUX_COOLDOWN = 8; // recharge after the window — longer than nitro's 6s, a freeze is stronger than a boost
export const FLUX_LEV = 10;     // leverage during the freeze — the program RMIN, ~zero price impact vs 2000×
export type FluxPhase = "ready" | "active" | "cool";

/**
 * Pure timer/state machine for the DeLorean's Flux Brake — no DOM, unit-testable.
 * Firing banks the current P&L and pins leverage to FLUX_LEV for FLUX_ACTIVE seconds
 * (main.ts feeds the pinned lev to the engine + the on-chain lever sync, whose rebank
 * IS the freeze — gains lock into `banked`, the new segment barely moves at 10×).
 * Nitro-style recharge: after the window it cools for FLUX_COOLDOWN, then re-arms.
 */
export function createFluxCore() {
  let enabled = false, live = false;
  let phase: FluxPhase = "ready";
  let timer = 0;
  return {
    get phase() { return phase; },
    get timer() { return timer; },
    /** the button is visible only when the car has the ability AND a round is live */
    get visible() { return enabled && live; },
    setEnabled(on: boolean) { enabled = on; if (!on) { phase = "ready"; timer = 0; } },
    /** request the freeze; true only if it actually engaged (ready + enabled + live) */
    fire(): boolean {
      if (enabled && live && phase === "ready") { phase = "active"; timer = FLUX_ACTIVE; return true; }
      return false;
    },
    /** advance timers; true while the freeze is active */
    update(dt: number, isLive: boolean): boolean {
      if (!isLive && live) { phase = "ready"; timer = 0; } // round ended → re-arm for the next one
      live = isLive;
      if (phase === "active" && live) {
        timer -= dt;
        if (timer <= 0) { phase = "cool"; timer = FLUX_COOLDOWN; } // window over → recharge
      } else if (phase === "cool" && live) {
        timer -= dt;
        if (timer <= 0) phase = "ready";
      }
      return phase === "active" && live;
    },
  };
}

/**
 * DeLorean's "Flux Brake": tap to bank your P&L and freeze it for ~4s (leverage pins
 * to the 10× minimum, so the market barely touches you), then the throttle takes back
 * over. A cyan time-circuit button opposite the nitro thumb spot; the whole scene gets
 * a cold flux tint while frozen.
 */
export function createFlux(parent: HTMLElement, onFire?: () => void): Flux {
  const core = createFluxCore();

  if (!document.getElementById("flux-style")) {
    const s = document.createElement("style");
    s.id = "flux-style";
    s.textContent = `#gl.flux-scene{filter:saturate(.45) brightness(1.04) hue-rotate(-18deg) contrast(1.06);transition:filter .25s ease}`;
    document.head.appendChild(s);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe";
  btn.setAttribute("aria-label", "Flux Brake");
  btn.style.cssText = [
    "position:absolute",
    "left:max(14px,env(safe-area-inset-left))",
    "bottom:36%",
    "z-index:8",
    "width:66px", "height:66px", "padding:0",
    "display:none", "flex-direction:column", "align-items:center", "justify-content:center", "gap:1px",
    "border:2px solid rgba(39,231,255,.85)", "border-radius:50%", "cursor:pointer",
    "background:radial-gradient(circle at 50% 34%,rgba(60,200,255,.4),rgba(6,14,32,.94))",
    "color:#fff", "font:800 9px/1 'Chakra Petch',ui-monospace,monospace", "letter-spacing:.1em",
    "box-shadow:0 0 18px rgba(39,231,255,.55)", "transition:opacity .15s ease,transform .1s ease",
  ].join(";");
  // the flux capacitor Y — three spokes into a hub
  const yGlyph = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 12V21M12 12L5 4.5M12 12L19 4.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>';
  btn.innerHTML = `<span style="display:flex;filter:drop-shadow(0 0 6px rgba(39,231,255,.9))">${yGlyph}</span><span class="fl">FLUX</span>`;
  const labelEl = btn.querySelector(".fl") as HTMLElement;
  parent.appendChild(btn);

  const render = () => {
    const show = core.visible;
    btn.style.display = show ? "flex" : "none";
    document.getElementById("gl")?.classList.toggle("flux-scene", show && core.phase === "active");
    if (!show) return;
    if (core.phase === "active") {
      btn.style.opacity = "1";
      btn.style.borderColor = "#bdf3ff";
      btn.style.boxShadow = "0 0 28px rgba(120,240,255,.95)";
      btn.style.transform = "scale(1.08)";
      labelEl.textContent = core.timer.toFixed(1);
    } else if (core.phase === "cool") {
      btn.style.opacity = "0.4";
      btn.style.borderColor = "rgba(150,150,170,.6)";
      btn.style.boxShadow = "none";
      btn.style.transform = "scale(1)";
      labelEl.textContent = Math.ceil(core.timer) + "s"; // nitro-style recharge countdown
    } else {
      btn.style.opacity = "1";
      btn.style.borderColor = "rgba(39,231,255,.85)";
      btn.style.boxShadow = "0 0 18px rgba(39,231,255,.55)";
      btn.style.transform = "scale(1)";
      labelEl.textContent = "FLUX";
    }
  };

  onTap(btn, () => { if (core.fire()) onFire?.(); render(); });

  return {
    setEnabled(on) { core.setEnabled(on); render(); },
    update(dt, isLive) {
      const active = core.update(dt, isLive);
      render(); // re-assert visibility every frame — setHudMenuMode resets inline display on close
      return active;
    },
  };
}
