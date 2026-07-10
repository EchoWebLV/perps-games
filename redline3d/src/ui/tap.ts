/** Wire a control so ANY finger's tap fires it — browsers only synthesize `click`
 *  for the primary pointer, so a second finger (e.g. while the other holds the gas)
 *  never clicks. pointerdown on the element arms it; pointerup on it fires. A recent
 *  pointer-fire suppresses the element's next synthetic click (a primary tap would
 *  double-fire); a click with no prior pointer-fire (keyboard Enter/Space, test
 *  .click(), mouse fallback) still fires. */
export function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  let armedId: number | null = null;
  let firedAt = 0;
  el.addEventListener("pointerdown", (e: PointerEvent) => { armedId = e.pointerId; });
  el.addEventListener("pointercancel", () => { armedId = null; });
  el.addEventListener("pointerup", (e: PointerEvent) => {
    if (armedId !== e.pointerId) return;
    armedId = null;
    firedAt = Date.now();
    fn(e);
  });
  el.addEventListener("click", (e) => {
    if (Date.now() - firedAt < 500) return; // the synthetic click that follows our pointerup
    fn(e);
  });
}
