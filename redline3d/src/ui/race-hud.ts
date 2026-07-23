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
// Comic sticker styling: thick near-black ink borders, chunky rounded corners, HARD offset drop
// shadows (no blur), flat bright accent fills, heavy type. Same layout/info as before — reskin only.
const INK = "#0a0812";
const CSS = `
.rh-root{position:fixed;inset:0;pointer-events:none;font-family:'Chakra Petch',ui-monospace,monospace;color:#f4f0ff;z-index:20;}
.rh-board{position:absolute;left:14px;top:14px;width:236px;background:#241640;border:3px solid ${INK};border-radius:14px;padding:10px 10px 8px;box-shadow:5px 5px 0 rgba(8,5,16,.9);}
.rh-board h3{margin:0 0 8px;font-size:12px;letter-spacing:.16em;font-weight:800;color:#ffe08a;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center;}
.rh-live{font-size:9px;letter-spacing:.12em;color:#07120a;font-weight:800;background:#3ff08a;border:2px solid ${INK};border-radius:99px;padding:2px 8px;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
.rh-rows{display:flex;flex-direction:column;gap:4px;}
.rh-row{display:flex;align-items:center;gap:8px;padding:4px 7px;border-radius:9px;background:#31204d;border:2px solid ${INK};transition:transform .1s,background .18s;cursor:pointer;-webkit-tap-highlight-color:transparent;pointer-events:auto;}
.rh-row:hover{background:#3b2860;}
.rh-row:active{transform:translate(1px,1px);}
.rh-row.lead{background:#0f7fa8;}
.rh-row.focus{border-color:#ffe08a;box-shadow:3px 3px 0 rgba(8,5,16,.8);}
.rh-row.focus .rh-name::after{content:' ◉';color:#ffe08a;}
.rh-pos{width:20px;text-align:center;font-weight:800;font-size:14px;color:#e6ddff;font-variant-numeric:tabular-nums;}
.rh-row.lead .rh-pos{color:#fff;}
.rh-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;border:2px solid ${INK};}
.rh-name{flex:1;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.rh-status{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;background:#241640;border:3px solid ${INK};border-radius:99px;padding:7px 18px;box-shadow:4px 4px 0 rgba(8,5,16,.9);}
.rh-lap{font-size:16px;font-weight:800;letter-spacing:.06em;color:#f4f0ff;font-variant-numeric:tabular-nums;}
.rh-phase{font-size:11px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;}
.rh-phase[data-p="COUNTDOWN"]{color:#ffd166;}
.rh-phase[data-p="RACING"]{color:#41d67f;}
.rh-phase[data-p="FINISH"]{color:#ff5da0;}
.rh-phase[data-p="MARKET"]{color:#9ad7ff;}
.rh-phase[data-p="LOADING"]{color:#9ad7ff;}
.rh-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.rh-count span{font-size:170px;font-weight:800;color:#ffe08a;-webkit-text-stroke:6px ${INK};text-shadow:7px 7px 0 ${INK};animation:rh-pop .5s ease-out;}
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
