import { onTap } from "./tap";

export interface Magnet {
  /** show the button only for the car that has the ability */
  setEnabled(on: boolean): void;
  /** advance timers + button visuals; true while the coin-vacuum burst is active */
  update(dt: number, live: boolean): boolean;
}

export const MAGNET_ACTIVE = 4;   // seconds the coin-vacuum is on
export const MAGNET_COOLDOWN = 7; // recharge after the burst, then re-arms
export type MagnetPhase = "ready" | "active" | "cool";

/**
 * Pure timer/state machine for the Magnet's coin-vacuum burst — no DOM, unit-testable.
 * Firing turns the pickups magnet ON for MAGNET_ACTIVE seconds (main.ts feeds the
 * returned flag into pickups.setMagnet, so coins curve into the car during the window),
 * then it cools for MAGNET_COOLDOWN and re-arms. Same nitro/flux recharge shape — the
 * magnet used to be always-on; now it's a chargeable tap like the Nitro / Flux buttons.
 */
export function createMagnetCore() {
  let enabled = false, live = false;
  let phase: MagnetPhase = "ready";
  let timer = 0;
  return {
    get phase() { return phase; },
    get timer() { return timer; },
    /** the button is visible only when the car has the ability AND a round is live */
    get visible() { return enabled && live; },
    setEnabled(on: boolean) { enabled = on; if (!on) { phase = "ready"; timer = 0; } },
    /** request the burst; true only if it actually engaged (ready + enabled + live) */
    fire(): boolean {
      if (enabled && live && phase === "ready") { phase = "active"; timer = MAGNET_ACTIVE; return true; }
      return false;
    },
    /** advance timers; true while the coin-vacuum is active */
    update(dt: number, isLive: boolean): boolean {
      if (!isLive && live) { phase = "ready"; timer = 0; } // round ended → re-arm for the next one
      live = isLive;
      if (phase === "active" && live) {
        timer -= dt;
        if (timer <= 0) { phase = "cool"; timer = MAGNET_COOLDOWN; } // window over → recharge
      } else if (phase === "cool" && live) {
        timer -= dt;
        if (timer <= 0) phase = "ready";
      }
      return phase === "active" && live;
    },
  };
}

/**
 * Magnet's "Coin Magnet": tap to reel every coin into the car for ~4s, then a short
 * cooldown. A purple horseshoe button in the same thumb spot as the nitro / flux
 * buttons (only one car's ability shows at a time). main.ts feeds the returned flag
 * to pickups.setMagnet each frame.
 */
export function createMagnet(parent: HTMLElement, onFire?: () => void): Magnet {
  const core = createMagnetCore();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe";
  btn.setAttribute("aria-label", "Coin Magnet");
  btn.style.cssText = [
    "position:absolute",
    "left:max(14px,env(safe-area-inset-left))",
    "bottom:36%",
    "z-index:8",
    "width:66px", "height:66px", "padding:0",
    "display:none", "flex-direction:column", "align-items:center", "justify-content:center", "gap:1px",
    "border:2px solid rgba(176,107,255,.85)", "border-radius:50%", "cursor:pointer",
    "background:radial-gradient(circle at 50% 34%,rgba(176,107,255,.45),rgba(18,8,32,.94))",
    "color:#fff", "font:800 9px/1 'Chakra Petch',ui-monospace,monospace", "letter-spacing:.1em",
    "box-shadow:0 0 18px rgba(176,107,255,.55)", "transition:opacity .15s ease,transform .1s ease",
  ].join(";");
  // horseshoe magnet — matches the card icon
  const glyph = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v8a5 5 0 0 0 10 0V3"/><path d="M7 7h3M14 7h3"/></svg>';
  btn.innerHTML = `<span style="display:flex;filter:drop-shadow(0 0 6px rgba(176,107,255,.9))">${glyph}</span><span class="ml">MAGNET</span>`;
  const labelEl = btn.querySelector(".ml") as HTMLElement;
  parent.appendChild(btn);

  const render = () => {
    const show = core.visible;
    btn.style.display = show ? "flex" : "none";
    if (!show) return;
    if (core.phase === "active") {
      btn.style.opacity = "1";
      btn.style.borderColor = "#e0c4ff";
      btn.style.boxShadow = "0 0 28px rgba(200,150,255,.95)";
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
      btn.style.borderColor = "rgba(176,107,255,.85)";
      btn.style.boxShadow = "0 0 18px rgba(176,107,255,.55)";
      btn.style.transform = "scale(1)";
      labelEl.textContent = "MAGNET";
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
