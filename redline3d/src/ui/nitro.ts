import { onTap } from "./tap";

export interface Nitro {
  /** show the button only for the car that has the ability */
  setEnabled(on: boolean): void;
  /** advance timers + button visuals; returns the live leverage multiplier (1 or 2×) */
  update(dt: number, live: boolean): number;
}

export const NITRO_ACTIVE = 3;     // seconds of overdrive
export const NITRO_COOLDOWN = 6;   // seconds before it can fire again
export const NITRO_MULT = 2;       // 2× leverage during the burst
export type NitroPhase = "ready" | "active" | "cool";

/**
 * Pure timer/state machine for the Nitro Overdrive — no DOM, so it's unit-testable.
 * The button (createNitro) is a thin view over this.
 */
export function createNitroCore() {
  let enabled = false, live = false;
  let phase: NitroPhase = "ready";
  let timer = 0;
  return {
    get phase() { return phase; },
    get timer() { return timer; },
    /** the button is visible only when the car has the ability AND a round is live */
    get visible() { return enabled && live; },
    setEnabled(on: boolean) { enabled = on; if (!on) { phase = "ready"; timer = 0; } },
    /** request activation; returns true only if it actually fired (ready + enabled + live) */
    fire(): boolean {
      if (enabled && live && phase === "ready") { phase = "active"; timer = NITRO_ACTIVE; return true; }
      return false;
    },
    /** advance timers; returns the leverage multiplier (1 normally, 2 during the burst) */
    update(dt: number, isLive: boolean): number {
      if (!isLive && live) { phase = "ready"; timer = 0; } // round ended → reset
      live = isLive;
      let mult = 1;
      if (phase === "active") {
        timer -= dt; mult = NITRO_MULT;
        if (timer <= 0) { phase = "cool"; timer = NITRO_COOLDOWN; }
      } else if (phase === "cool") {
        timer -= dt;
        if (timer <= 0) phase = "ready";
      }
      return mult;
    },
  };
}

/**
 * Orion's "Nitro Overdrive": tap to double your leverage for 3s (bursting past the
 * cap), then a short cooldown. A circular flame button on the left, thumb-reachable
 * while driving. main.ts applies the returned multiplier to the leverage it feeds
 * the round engine; the engine rebanks on the change so the boundary is clean.
 */
export function createNitro(parent: HTMLElement, onFire?: () => void): Nitro {
  const core = createNitroCore();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pe";
  btn.setAttribute("aria-label", "Nitro Overdrive");
  btn.style.cssText = [
    "position:absolute",
    "left:max(14px,env(safe-area-inset-left))",
    "bottom:36%",
    "z-index:8",
    "width:66px", "height:66px", "padding:0",
    "display:none", "flex-direction:column", "align-items:center", "justify-content:center", "gap:1px",
    "border:2px solid rgba(255,140,40,.85)", "border-radius:50%", "cursor:pointer",
    "background:radial-gradient(circle at 50% 34%,rgba(255,170,60,.5),rgba(40,12,4,.92))",
    "color:#fff", "font:800 9px/1 'Chakra Petch',ui-monospace,monospace", "letter-spacing:.1em",
    "box-shadow:0 0 18px rgba(255,120,30,.6)", "transition:opacity .15s ease,transform .1s ease",
  ].join(";");
  const flame = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M13 2c.7 3.4-2.8 4.8-2.8 8.2a2.5 2.5 0 0 0 5 0c0-.7-.2-1.3-.4-1.9 1.8 1.1 2.9 3 2.9 5.1a5.7 5.7 0 0 1-11.4 0C6.3 8.7 10 6.4 13 2z"/></svg>';
  btn.innerHTML = `<span style="display:flex;filter:drop-shadow(0 0 5px rgba(255,150,40,.8))">${flame}</span><span class="nl">NITRO</span>`;
  const labelEl = btn.querySelector(".nl") as HTMLElement;
  parent.appendChild(btn);

  const render = () => {
    const show = core.visible;
    btn.style.display = show ? "flex" : "none";
    if (!show) return;
    if (core.phase === "active") {
      btn.style.opacity = "1";
      btn.style.borderColor = "#ffd166";
      btn.style.boxShadow = "0 0 28px rgba(255,200,60,.95)";
      btn.style.transform = "scale(1.08)";
      labelEl.textContent = core.timer.toFixed(1);
    } else if (core.phase === "cool") {
      btn.style.opacity = "0.4";
      btn.style.borderColor = "rgba(150,150,170,.6)";
      btn.style.boxShadow = "none";
      btn.style.transform = "scale(1)";
      labelEl.textContent = Math.ceil(core.timer) + "s";
    } else {
      btn.style.opacity = "1";
      btn.style.borderColor = "rgba(255,140,40,.85)";
      btn.style.boxShadow = "0 0 18px rgba(255,120,30,.6)";
      btn.style.transform = "scale(1)";
      labelEl.textContent = "NITRO";
    }
  };

  onTap(btn, () => { if (core.fire()) onFire?.(); render(); });

  return {
    setEnabled(on) { core.setEnabled(on); render(); },
    update(dt, isLive) {
      const mult = core.update(dt, isLive);
      render(); // re-assert visibility every frame — setHudMenuMode resets inline display on close
      return mult;
    },
  };
}
