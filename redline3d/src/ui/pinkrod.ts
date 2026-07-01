/**
 * Auto-Exit — the Pink Rod car's stop-loss / take-profit panel.
 *
 * Two pre-round sliders (equity-× units, the same multiplier the HUD shows) whose values
 * are stamped on-chain at GO (`Round.sl_fp` / `tp_fp`): the permissionless crank then
 * auto-cashes-out the round when equity crosses either threshold — even with the app
 * closed. OFF (the default, and the only thing every other car ever sends) is the
 * program's `0` sentinel, so an un-set panel is byte-identical to today's behavior.
 *
 * The discrete stops are chosen to live strictly inside the program clamps (SL above the
 * worst 0.20 liq floor — a gap THROUGH the stop to under the floor still liquidates; TP
 * below the ×25 cap), so the UI can never request a value the program would clamp.
 * Nitro-style split: a pure DOM-free core (unit-tested) + a thin panel view.
 */

export const SLS = [0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]; // stop-loss stops (slider 1..8; 0 = OFF)
export const TPS = [1.5, 2, 3, 4, 5, 7, 10, 15, 20];          // take-profit stops (slider 0..8; 9 = OFF)

const toFp = (x: number) => Math.round(x * 1_000_000); // equity-× → on-chain SCALE units

export interface AutoExit {
  /** show the panel only for the Pink Rod car */
  setEnabled(on: boolean): void;
  /** lock (dim + ignore input) while a round is live — values are stamped at GO */
  setLive(on: boolean): void;
  /** current thresholds in on-chain SCALE units; 0 = OFF (unset) */
  values(): { slFp: number; tpFp: number };
}

/** Pure slider-state core — no DOM, unit-testable. */
export function createAutoExitCore() {
  let slIdx = 0;          // 0 = OFF, 1.. = SLS[i-1]
  let tpIdx = TPS.length; // TPS.length = OFF (far right), 0.. = TPS[i]
  return {
    get slIdx() { return slIdx; },
    get tpIdx() { return tpIdx; },
    setSl(i: number) { slIdx = Math.max(0, Math.min(SLS.length, Math.round(i))); },
    setTp(i: number) { tpIdx = Math.max(0, Math.min(TPS.length, Math.round(i))); },
    slLabel(): string { return slIdx === 0 ? "OFF" : `×${SLS[slIdx - 1]}`; },
    tpLabel(): string { return tpIdx === TPS.length ? "OFF" : `×${TPS[tpIdx]}`; },
    values(): { slFp: number; tpFp: number } {
      return {
        slFp: slIdx === 0 ? 0 : toFp(SLS[slIdx - 1]),
        tpFp: tpIdx === TPS.length ? 0 : toFp(TPS[tpIdx]),
      };
    },
  };
}

/** The panel view: appended to the pre-round control stack (ctrlMount). */
export function createAutoExit(mount: HTMLElement): AutoExit {
  const core = createAutoExitCore();
  const box = document.createElement("div");
  box.className = "pe";
  box.style.cssText =
    "background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 9px;display:none;transition:opacity .3s ease";
  const row = (id: string, label: string, max: number, value: number) =>
    `<div style="display:flex;align-items:center;gap:8px;margin-top:6px">
       <span class="lbl" style="width:34px">${label}</span>
       <input id="${id}" type="range" min="0" max="${max}" step="1" value="${value}"
         style="flex:1;accent-color:#ff39c0;margin:0">
       <span id="${id}v" class="num" style="width:44px;text-align:right;font-size:13px">OFF</span>
     </div>`;
  box.innerHTML =
    `<span class="lbl" style="display:block">auto-exit</span>` +
    row("axsl", "stop", SLS.length, 0) +
    row("axtp", "take", TPS.length, TPS.length);
  mount.appendChild(box);

  const sl = box.querySelector("#axsl") as HTMLInputElement;
  const tp = box.querySelector("#axtp") as HTMLInputElement;
  const slv = box.querySelector("#axslv") as HTMLElement;
  const tpv = box.querySelector("#axtpv") as HTMLElement;
  const paint = () => {
    slv.textContent = core.slLabel();
    tpv.textContent = core.tpLabel();
    // the readout lights up magenta when armed, mut when OFF
    slv.style.color = core.slIdx === 0 ? "var(--mut)" : "#ff6ad5";
    tpv.style.color = core.tpIdx === TPS.length ? "var(--mut)" : "#ff6ad5";
  };
  sl.oninput = () => { core.setSl(Number(sl.value)); paint(); };
  tp.oninput = () => { core.setTp(Number(tp.value)); paint(); };
  paint();

  let enabled = false, live = false;
  const refresh = () => {
    box.style.display = enabled ? "block" : "none";
    box.style.opacity = live ? "0.45" : "1";        // live: armed + locked
    box.style.pointerEvents = live ? "none" : "auto";
  };
  refresh();

  return {
    setEnabled(on) { enabled = on; refresh(); },
    setLive(on) { live = on; refresh(); },
    values: () => core.values(),
  };
}
