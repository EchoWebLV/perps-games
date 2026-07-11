/** Wire a control so ANY finger's tap fires it — browsers only synthesize `click`
 *  for the primary pointer, so a second finger (e.g. while the other holds the gas)
 *  never clicks. pointerdown on the element arms it; pointerup on it fires. A recent
 *  pointer-fire suppresses the element's next synthetic click (a primary tap would
 *  double-fire); a click with no prior pointer-fire (keyboard Enter/Space, test
 *  .click(), mouse fallback) still fires. On top of that per-element guard, each
 *  pointer-fire also arms a one-shot, window-level capture-phase suppressor so the
 *  tap's trailing synthetic click is eaten even if it RETARGETS to another element. */
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  let armedId: number | null = null;
  let firedAt = 0;
  el.addEventListener("pointerdown", (e: PointerEvent) => { armedId = e.pointerId; });
  el.addEventListener("pointercancel", () => { armedId = null; });
  el.addEventListener("pointerup", (e: PointerEvent) => {
    if (armedId !== e.pointerId) return;
    armedId = null;
    firedAt = Date.now();
    // The tap's trailing synthetic click can RETARGET when fn changes the DOM under
    // the finger (Android WebView hit-tests it against the NEW top element): opening
    // a tap-outside-to-close overlay would swallow its own opening tap. Eat this
    // gesture's click wherever it lands; the per-element firedAt check above stays
    // as the fallback for environments without a window (unit-test fake DOM).
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      const kill = (ce: Event) => { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener("click", kill, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", kill, true), 400);
    }
    fn(e);
  });
  el.addEventListener("click", (e) => {
    if (Date.now() - firedAt < 500) return; // the synthetic click that follows our pointerup
    fn(e);
  });
}
