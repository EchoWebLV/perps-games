import { tierOf } from "../core/rarity";

// Shared, presentation-only crate-opening choreography: a full-screen "pack rip" (drop → shake →
// escalate → burst → card flip → prize chips), Claynosaurz-style, in real-time DOM/CSS — no video.
// It knows NOTHING about outcomes: the consumer fills the card face at flip time via onCardSlot,
// so the SAME module drives the game's real VRF pull (src/ui/cratebox.ts) and the marketing
// landing's demo pull. Because the landing bundle must stay free of three.js and game code, the
// ONLY dependency allowed here is core/rarity (DOM-free) — never three, main, cratebox, or economy.

export interface CinematicPrizeChip { label: string; color?: string }
export interface CinematicRevealOpts {
  rarity: number;                          // 1..5 → drama scale
  onCardSlot: (slot: HTMLElement) => void; // consumer fills the card face at flip time
  chips?: CinematicPrizeChip[];            // e.g. "+250 SCRAP", "⛓ MagicBlock VRF"
  doneLabel?: string;                      // default "Done"
  hideDone?: boolean;                      // game mode: consumer keeps its own buttons
}
export interface CrateCinematicRun {
  reveal(opts: CinematicRevealOpts): void; // rip → flip; second call is a no-op
  abort(): void;                           // tear down without reveal (VRF failure path)
}
export interface CrateCinematic {
  el: HTMLElement;                         // overlay root; consumer appends it where it wants
  open(opts: { crateImgUrl?: string; crateColor: string; loop?: boolean }): CrateCinematicRun;
  dispose(): void;
}

// The escalation dwell before the crate bursts, scaled by rarity: commons rip fast, legendaries
// slow-burn. Reduced-motion / low-tier collapses this to 0 (see reveal()).
export const SHAKE_EXTRA_MS: Record<number, number> = { 1: 200, 2: 350, 3: 600, 4: 1100, 5: 1800 };
const DROP_MS = 500;    // drop-in settle → begin the shake
const FLASH_MS = 230;   // white burst → card flip
const CHIP_STAGGER_MS = 90; // per-chip cascade in

const STYLE_ID = "crate-cinematic-style";
// One shared sheet, injected once, `ccx-` namespaced so it can never collide with cratebox's own
// crate-shake classes (shake/shakeloop/gone live in BOTH namespaces on purpose).
const CSS = `
@keyframes ccx-drop{0%{transform:translateY(-42vh)}70%{transform:translateY(7px)}85%{transform:translateY(-3px)}100%{transform:translateY(0)}}
@keyframes ccx-shake{
  10%,90%{transform:translate3d(calc(var(--amp,1)*-1px),0,0)}
  20%,80%{transform:translate3d(calc(var(--amp,1)*2px),0,0)}
  30%,50%,70%{transform:translate3d(calc(var(--amp,1)*-4px),0,0) rotate(calc(var(--amp,1)*-1deg))}
  40%,60%{transform:translate3d(calc(var(--amp,1)*4px),0,0) rotate(calc(var(--amp,1)*1deg))}
}
@keyframes ccx-flash{0%{opacity:0}30%{opacity:.95}100%{opacity:0}}
@keyframes ccx-burst{0%{transform:scale(1);opacity:1}100%{transform:scale(1.5);opacity:0}}
@keyframes ccx-flip{0%{transform:rotateY(90deg) scale(.72);opacity:0}70%{transform:rotateY(0) scale(1.05);opacity:1}100%{transform:rotateY(0) scale(1)}}
@keyframes ccx-fade{from{opacity:0}to{opacity:1}}
.ccx-root{position:fixed;inset:0;z-index:10000;display:none;flex-direction:column;align-items:center;justify-content:center;
  padding:max(22px,env(safe-area-inset-top)) 18px;background:rgba(3,2,10,.86);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);pointer-events:auto}
.ccx-root.ccx-on{display:flex}
.ccx-stage{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:260px}
.ccx-crate{width:124px;height:112px;object-fit:contain;border-radius:12px;filter:drop-shadow(0 6px 16px color-mix(in srgb,var(--cc,#fff) 55%,transparent))}
.ccx-box{position:relative;background:linear-gradient(160deg,color-mix(in srgb,var(--cc,#888) 58%,#160f2c),#140d26);
  border:2px solid var(--cc,#888);box-shadow:0 0 22px color-mix(in srgb,var(--cc,#888) 45%,transparent)}
.ccx-box::after{content:"";position:absolute;left:0;right:0;top:50%;height:14px;transform:translateY(-50%);background:var(--cc,#888);opacity:.9}
.ccx-crate.drop-in{animation:ccx-drop .5s cubic-bezier(.22,1.2,.36,1) both}
.ccx-crate.shake{animation:ccx-shake .5s cubic-bezier(.36,.07,.19,.97) both}
.ccx-crate.shakeloop{animation:ccx-shake .5s cubic-bezier(.36,.07,.19,.97) infinite}
.ccx-crate.gone{animation:ccx-burst .3s ease-out forwards}
.ccx-crate.shake-r1{--amp:.6}
.ccx-crate.shake-r2{--amp:1}
.ccx-crate.shake-r3{--amp:1.6;filter:drop-shadow(0 0 12px var(--tc,#fff))}
.ccx-crate.shake-r4{--amp:2.4;filter:drop-shadow(0 0 18px var(--tc,#fff))}
.ccx-crate.shake-r5{--amp:3.4;filter:drop-shadow(0 0 26px var(--tc,#fff))}
.ccx-flash{position:absolute;top:50%;left:50%;width:220px;height:220px;margin:-110px 0 0 -110px;
  background:radial-gradient(circle,#fff,transparent 62%);opacity:0;pointer-events:none}
.ccx-flash.go{animation:ccx-flash .23s ease-out}
.ccx-card{display:none;position:relative;perspective:900px}
.ccx-card.flip-in{display:block;animation:ccx-flip .38s cubic-bezier(.22,1.2,.36,1) both}
.ccx-frame{padding:12px;border-radius:16px;border:2px solid var(--tc,#8496e0);
  box-shadow:0 0 26px color-mix(in srgb,var(--tc,#8496e0) 55%,transparent);
  background:linear-gradient(180deg,rgba(20,14,40,.96),rgba(10,7,22,.98))}
.ccx-slot{display:flex;align-items:center;justify-content:center;min-width:180px;min-height:180px}
.ccx-chips{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;max-width:min(560px,94vw)}
.ccx-chip{opacity:0;transform:translateY(10px);padding:8px 13px;border-radius:10px;background:rgba(18,14,40,.85);
  border:1px solid color-mix(in srgb,var(--tc,#8496e0) 55%,rgba(132,150,224,.3));color:#e6ecf7;
  font:800 13px/1 'Chakra Petch',ui-monospace,monospace;transition:opacity .25s ease,transform .25s ease}
.ccx-chip.in{opacity:1;transform:translateY(0)}
.ccx-done{margin-top:2px;border:1px solid color-mix(in srgb,var(--tc,#8496e0) 60%,rgba(132,150,224,.4));border-radius:10px;
  padding:11px 24px;cursor:pointer;background:rgba(14,10,28,.9);color:#e6ecf7;
  font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase}
.ccx-done[hidden]{display:none}
@media (prefers-reduced-motion: reduce){
  .ccx-crate.drop-in,.ccx-crate.shake,.ccx-crate.shakeloop,.ccx-crate.gone,.ccx-flash.go,.ccx-card.flip-in{animation:ccx-fade .2s ease both}
  .ccx-chip{transition:opacity .2s ease}
}`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID; st.textContent = CSS;
  document.head.appendChild(st);
}

// OS reduced-motion, guarded for non-DOM/test envs where matchMedia is absent.
const prefersReducedMotion = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createCrateCinematic({ lowTier, onDone }: { lowTier?: boolean; onDone: () => void }): CrateCinematic {
  injectStyles();

  const root = document.createElement("div");
  root.className = "ccx-root";
  const stage = document.createElement("div");
  stage.className = "ccx-stage";
  root.appendChild(stage);

  // All pending timers tracked centrally so abort()/dispose() (and re-entrant open()) can kill the
  // WHOLE choreography — no orphaned callback ever mutates a torn-down stage.
  const timers = new Set<number>();
  const after = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };
  const clearTimers = (): void => { for (const id of timers) clearTimeout(id); timers.clear(); };

  let teardownActive: (() => void) | null = null; // the live run's abort, so a new open() unwinds it

  const resetStage = (): void => {
    clearTimers();
    stage.textContent = "";
    root.classList.remove("ccx-on");
  };

  function open(opts: { crateImgUrl?: string; crateColor: string; loop?: boolean }): CrateCinematicRun {
    if (teardownActive) teardownActive(); // re-entrancy: implicitly abort the previous run
    resetStage();

    const { crateImgUrl, crateColor, loop } = opts;
    const crate = document.createElement(crateImgUrl ? "img" : "div");
    crate.className = crateImgUrl ? "ccx-crate drop-in" : "ccx-crate ccx-box drop-in";
    if (crateImgUrl) (crate as HTMLImageElement).src = crateImgUrl;
    crate.style.setProperty("--cc", crateColor); // colored-box fallback + drop-shadow glow

    const flash = document.createElement("div"); flash.className = "ccx-flash";
    const card = document.createElement("div"); card.className = "ccx-card";
    const frame = document.createElement("div"); frame.className = "ccx-frame";
    const slot = document.createElement("div"); slot.className = "ccx-slot";
    frame.appendChild(slot); card.appendChild(frame);
    const chipsRow = document.createElement("div"); chipsRow.className = "ccx-chips";
    const done = document.createElement("button");
    done.className = "ccx-done"; done.type = "button"; done.hidden = true;
    done.addEventListener("click", onDone);

    stage.append(crate, flash, card, chipsRow, done);
    root.classList.add("ccx-on");

    after(DROP_MS, () => { crate.classList.remove("drop-in"); crate.classList.add(loop ? "shakeloop" : "shake"); });

    let revealed = false;
    let aborted = false;

    const showDone = (o: CinematicRevealOpts): void => {
      if (o.hideDone) return; // game mode keeps its own buttons; module never surfaces Done
      done.textContent = o.doneLabel ?? "Done";
      done.hidden = false;
    };

    const reveal = (o: CinematicRevealOpts): void => {
      if (revealed || aborted) return; // second reveal is a no-op
      revealed = true;
      const r = o.rarity;
      const tc = tierOf(r).color;
      crate.style.setProperty("--tc", tc); // escalation glow tint
      crate.classList.add(`shake-r${r}`);

      const escalate = (lowTier || prefersReducedMotion()) ? 0 : SHAKE_EXTRA_MS[r];
      after(escalate, () => {
        crate.classList.remove("shake", "shakeloop", "drop-in", `shake-r${r}`);
        crate.classList.add("gone");
        flash.classList.add("go");
        if (r >= 4) flash.style.transform = "scale(1.5)"; // epic+ gets a bigger burst (mirrors cratebox)

        after(FLASH_MS, () => {
          card.style.setProperty("--tc", tc);
          card.classList.add("flip-in");
          o.onCardSlot(slot); // EXACTLY once — consumer fills the card face here

          const chips = o.chips ?? [];
          if (chips.length === 0) { showDone(o); return; }
          chips.forEach((chip, i) => {
            const el = document.createElement("div");
            el.className = "ccx-chip";
            el.textContent = chip.label;
            if (chip.color) el.style.setProperty("--tc", chip.color);
            chipsRow.appendChild(el);
            after(CHIP_STAGGER_MS * (i + 1), () => {
              el.classList.add("in");
              if (i === chips.length - 1) showDone(o); // Done follows the last chip
            });
          });
        });
      });
    };

    const abort = (): void => {
      aborted = true;
      resetStage();
      teardownActive = null;
    };
    teardownActive = abort;
    return { reveal, abort };
  }

  return {
    el: root,
    open,
    dispose() {
      if (teardownActive) teardownActive(); else resetStage();
      root.remove(); // instance DOM only; the shared module-level <style> stays
    },
  };
}
