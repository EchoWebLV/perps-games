export interface Joystick {
  /** show the base ring centered at a screen point (where the thumb landed) */
  show(x: number, y: number): void;
  /** move the knob by a drag delta from the anchor (clamped to the ring) */
  move(dx: number, dy: number): void;
  /** fade the joystick out (finger released) */
  hide(): void;
}

const TRAVEL = 46; // px the knob can move from center before it pins to the rim

/**
 * A classic on-screen virtual joystick: a translucent white ring that appears
 * where the player presses, with a glowing knob that follows the drag. Pure
 * visual feedback for the hold-anywhere-to-drive controls — pointer-events:none,
 * driven by the canvas hold/drag handlers in main.ts.
 */
export function createJoystick(): Joystick {
  const base = document.createElement("div");
  base.style.cssText =
    "position:fixed;z-index:8;pointer-events:none;width:124px;height:124px;margin:-62px 0 0 -62px;" +
    "border-radius:50%;border:2px solid rgba(255,255,255,.5);background:rgba(255,255,255,.06);" +
    "opacity:0;transition:opacity .12s ease;will-change:transform,opacity";

  const knob = document.createElement("div");
  knob.style.cssText =
    "position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;" +
    "background:rgba(255,255,255,.9);box-shadow:0 0 16px rgba(255,255,255,.55);" +
    "transition:transform .04s linear";
  base.appendChild(knob);
  document.body.appendChild(base);

  return {
    show(x, y) {
      base.style.left = x + "px";
      base.style.top = y + "px";
      knob.style.transform = "translate(0,0)";
      base.style.opacity = "1";
    },
    move(dx, dy) {
      const m = Math.hypot(dx, dy);
      const s = m > TRAVEL ? TRAVEL / m : 1;
      knob.style.transform = `translate(${(dx * s).toFixed(1)}px,${(dy * s).toFixed(1)}px)`;
    },
    hide() {
      base.style.opacity = "0";
    },
  };
}
