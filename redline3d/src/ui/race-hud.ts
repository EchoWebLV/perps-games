// Race spectator HUD (dev-only, used by src/race-preview.ts). DOM overlay owning the on-track
// read: a live position board (rarity-colored dot + name), the lap counter, the race-state line,
// and the 3-2-1-GO countdown. Odds, the bet slip and the finish settlement live in the separate
// bet-panel module; this stays focused on the race itself. Self-contained: injects its own
// <style> once and is driven every frame by render().
import { onTap } from "./tap";

export type RacePhase = "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH";

export interface RaceHudCar {
  id: number;
  name: string;
  color: string; // rarity tier color (hex string)
}

export interface RaceHudState {
  phase: RacePhase;
  order: number[]; // car ids, index 0 = 1st place
  leaderId: number | null;
  focusId: number | null; // car the camera is focused on (persistent highlight)
  lap: number; // 1..totalLaps (leader's lap)
  totalLaps: number;
  countdown: string | null; // "3" | "2" | "1" | "GO" | null
}

export interface RaceHud {
  el: HTMLElement;
  setRoster(cars: RaceHudCar[]): void;
  render(s: RaceHudState): void;
  /** tap a leaderboard row → focus the camera on that car id */
  onRowTap(fn: (id: number) => void): void;
  dispose(): void;
}

const STYLE_ID = "race-hud-style";
const CSS = `
.rh-root{position:fixed;inset:0;pointer-events:none;font-family:'Chakra Petch',ui-monospace,monospace;color:#eaf2ff;z-index:20;}
.rh-board{position:absolute;left:14px;top:14px;width:236px;background:rgba(9,6,22,.72);border:1px solid rgba(122,90,220,.45);border-radius:12px;padding:10px 10px 8px;box-shadow:0 0 24px rgba(120,60,220,.25),inset 0 0 18px rgba(40,20,80,.4);backdrop-filter:blur(6px);}
.rh-board h3{margin:0 0 8px;font-size:12px;letter-spacing:.18em;font-weight:700;color:#9ad7ff;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center;}
.rh-live{font-size:9px;letter-spacing:.14em;color:#41d67f;border:1px solid rgba(65,214,127,.5);border-radius:99px;padding:2px 7px;}
.rh-rows{display:flex;flex-direction:column;gap:3px;}
.rh-row{display:flex;align-items:center;gap:8px;padding:4px 7px;border-radius:7px;background:rgba(255,255,255,.03);border:1px solid transparent;transition:background .18s,border-color .18s;cursor:pointer;-webkit-tap-highlight-color:transparent;pointer-events:auto;}
.rh-row:hover{background:rgba(255,255,255,.07);}
.rh-row:active{transform:translateY(1px);}
.rh-row.lead{background:rgba(39,231,255,.10);border-color:rgba(39,231,255,.5);}
.rh-row.focus{border-color:#27e7ff;box-shadow:0 0 12px rgba(39,231,255,.45);}
.rh-row.focus .rh-name::after{content:' ◉';color:#27e7ff;}
.rh-pos{width:20px;text-align:center;font-weight:700;font-size:14px;color:#c9d6ff;font-variant-numeric:tabular-nums;}
.rh-row.lead .rh-pos{color:#27e7ff;}
.rh-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 8px currentColor;}
.rh-name{flex:1;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.rh-status{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;background:rgba(9,6,22,.72);border:1px solid rgba(122,90,220,.45);border-radius:99px;padding:7px 16px;box-shadow:0 0 20px rgba(120,60,220,.22);}
.rh-lap{font-size:16px;font-weight:700;letter-spacing:.08em;color:#eaf2ff;font-variant-numeric:tabular-nums;}
.rh-phase{font-size:11px;letter-spacing:.16em;font-weight:700;text-transform:uppercase;}
.rh-phase[data-p="COUNTDOWN"]{color:#ffd166;}
.rh-phase[data-p="RACING"]{color:#41d67f;}
.rh-phase[data-p="FINISH"]{color:#ff5da0;}
.rh-phase[data-p="MARKET"]{color:#9ad7ff;}
.rh-phase[data-p="LOADING"]{color:#9ad7ff;}
.rh-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.rh-count span{font-size:160px;font-weight:700;color:#fff;text-shadow:0 0 40px rgba(39,231,255,.9),0 0 12px rgba(255,93,160,.8);animation:rh-pop .5s ease-out;}
@keyframes rh-pop{from{transform:scale(1.6);opacity:0;}to{transform:scale(1);opacity:1;}}
`;

export function createRaceHud(parent: HTMLElement = document.body): RaceHud {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.createElement("div");
  root.className = "rh-root";
  root.innerHTML = `
    <div class="rh-board">
      <h3><span>Positions</span><span class="rh-live">LIVE</span></h3>
      <div class="rh-rows"></div>
    </div>
    <div class="rh-status">
      <span class="rh-lap">LAP 1/3</span>
      <span class="rh-phase" data-p="LOADING">Loading cars…</span>
    </div>
    <div class="rh-count" style="display:none"><span></span></div>`;
  parent.appendChild(root);

  const boardEl = root.querySelector(".rh-board") as HTMLElement;
  const rowsWrap = root.querySelector(".rh-rows") as HTMLElement;
  const lapEl = root.querySelector(".rh-lap") as HTMLElement;
  const phaseEl = root.querySelector(".rh-phase") as HTMLElement;
  const countWrap = root.querySelector(".rh-count") as HTMLElement;
  const countEl = countWrap.querySelector("span") as HTMLElement;

  const rowById = new Map<number, { row: HTMLElement; pos: HTMLElement }>();

  const PHASE_LABEL: Record<RacePhase, string> = {
    LOADING: "Loading cars…",
    MARKET: "Market open",
    COUNTDOWN: "Get ready",
    RACING: "Racing",
    FINISH: "Finish",
  };

  let lastCount: string | null | undefined;
  let rowTapCb: (id: number) => void = () => {};

  return {
    el: root,
    setRoster(cars) {
      rowsWrap.innerHTML = "";
      rowById.clear();
      for (const c of cars) {
        const row = document.createElement("div");
        row.className = "rh-row";
        row.innerHTML = `
          <span class="rh-pos"></span>
          <span class="rh-dot" style="background:${c.color};color:${c.color}"></span>
          <span class="rh-name">${c.name}</span>`;
        onTap(row, () => rowTapCb(c.id)); // tap a row → focus the camera on that car
        rowsWrap.appendChild(row);
        rowById.set(c.id, { row, pos: row.querySelector(".rh-pos") as HTMLElement });
      }
    },
    render(s) {
      // the position board only makes sense once cars are staged / racing
      boardEl.style.display = (s.phase === "LOADING" || s.phase === "MARKET") ? "none" : "block";

      s.order.forEach((id, i) => {
        const r = rowById.get(id);
        if (!r) return;
        r.row.style.order = String(i);
        r.pos.textContent = String(i + 1);
        r.row.classList.toggle("lead", id === s.leaderId);
        r.row.classList.toggle("focus", id === s.focusId);
      });

      lapEl.textContent = `LAP ${Math.min(s.lap, s.totalLaps)}/${s.totalLaps}`;
      lapEl.style.display = (s.phase === "RACING" || s.phase === "FINISH") ? "inline" : "none";
      phaseEl.textContent = PHASE_LABEL[s.phase];
      phaseEl.dataset.p = s.phase;

      if (s.countdown !== lastCount) {
        lastCount = s.countdown;
        if (s.countdown) {
          countEl.textContent = s.countdown;
          countWrap.style.display = "flex";
          countEl.style.animation = "none";
          void countEl.offsetWidth; // reflow so the pop animation retriggers each number
          countEl.style.animation = "";
        } else {
          countWrap.style.display = "none";
        }
      }
    },
    onRowTap(fn) { rowTapCb = fn; },
    dispose() {
      root.remove();
    },
  };
}
