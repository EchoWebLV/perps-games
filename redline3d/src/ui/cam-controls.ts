// Manual camera control strip for the spectator-race preview (DEV-ONLY, used by
// src/race-preview.ts). Mode buttons AUTO / CHASE / TV / DRONE / FREE (keys 1–5) plus a FOCUS
// cycler (key F) that walks Leader → My Bet → each car. Holds the current mode + focus selection;
// the preview reads mode()/focusSel() each frame and drives the director / OrbitControls. Styling
// matches the bet panel's neon stake chips.
import { onTap } from "./tap";

export type CamMode = "AUTO" | "CHASE" | "TV" | "DRONE" | "FREE";
export type FocusSel = "leader" | "mybet" | number;

export interface CamControls {
  el: HTMLElement;
  mode(): CamMode;
  setMode(m: CamMode): void;
  focusSel(): FocusSel;
  /** focus a specific car index directly (carId < 0 resets to Leader) — shared with the FOCUS cycle */
  setFocusCar(carId: number): void;
  setFocusLabel(name: string): void;
  onModeChange(fn: (m: CamMode) => void): void;
  dispose(): void;
}

const MODES: CamMode[] = ["AUTO", "CHASE", "TV", "DRONE", "FREE"];
const STYLE_ID = "cam-controls-style";
const CSS = `
.cc-root{position:fixed;right:14px;bottom:16px;z-index:24;display:flex;flex-direction:column;gap:6px;align-items:flex-end;font-family:'Chakra Petch',ui-monospace,monospace;}
.cc-modes{display:flex;gap:6px;background:rgba(9,6,22,.8);border:1px solid rgba(122,90,220,.45);border-radius:10px;padding:6px;box-shadow:0 0 20px rgba(120,60,220,.25);pointer-events:auto;}
.cc-btn{cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.06em;color:#c9d6ff;background:rgba(255,255,255,.04);border:1px solid rgba(122,90,220,.45);border-radius:7px;padding:7px 11px;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-btn.sel{background:rgba(39,231,255,.16);border-color:#27e7ff;color:#eaf7ff;box-shadow:0 0 12px rgba(39,231,255,.4);}
.cc-focus{cursor:pointer;font-size:12px;font-weight:700;color:#ffd166;background:rgba(9,6,22,.8);border:1px solid rgba(255,209,102,.5);border-radius:8px;padding:6px 12px;box-shadow:0 0 14px rgba(255,160,40,.2);pointer-events:auto;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-hint{font-size:9px;color:#6b74a6;letter-spacing:.06em;}
`;

export function createCamControls(carCount: number, parent: HTMLElement = document.body): CamControls {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style"); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
  }
  const root = document.createElement("div");
  root.className = "cc-root";
  root.innerHTML = `
    <div class="cc-focus" title="cycle focus (F)">◉ Leader</div>
    <div class="cc-modes"></div>
    <div class="cc-hint">1 AUTO · 2 CHASE · 3 TV · 4 DRONE · 5 FREE · F focus</div>`;
  parent.appendChild(root);

  const modesEl = root.querySelector(".cc-modes") as HTMLElement;
  const focusEl = root.querySelector(".cc-focus") as HTMLElement;

  let mode: CamMode = "AUTO";
  // focus cycle: leader, my bet, then each car index
  const focusOrder: FocusSel[] = ["leader", "mybet", ...Array.from({ length: carCount }, (_, i) => i)];
  let focusIdx = 0;
  let changeCb: (m: CamMode) => void = () => {};

  const btns = new Map<CamMode, HTMLElement>();
  for (const m of MODES) {
    const b = document.createElement("div");
    b.className = "cc-btn" + (m === mode ? " sel" : "");
    b.textContent = m;
    onTap(b, () => setMode(m));
    modesEl.appendChild(b);
    btns.set(m, b);
  }

  function setMode(m: CamMode) {
    if (m === mode) return;
    mode = m;
    for (const [k, el] of btns) el.classList.toggle("sel", k === m);
    changeCb(m);
  }
  function cycleFocus() {
    focusIdx = (focusIdx + 1) % focusOrder.length;
  }

  onTap(focusEl, cycleFocus);

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= "5") setMode(MODES[+k - 1]);
    else if (k === "f") cycleFocus();
  };
  window.addEventListener("keydown", onKey);

  return {
    el: root,
    mode: () => mode,
    setMode,
    focusSel: () => focusOrder[focusIdx],
    setFocusCar: (carId) => {
      if (carId < 0) { focusIdx = 0; return; } // 0 = "leader"
      const at = focusOrder.indexOf(carId);
      if (at >= 0) focusIdx = at;
    },
    setFocusLabel: (name) => { focusEl.textContent = `◉ ${name}`; },
    onModeChange: (fn) => { changeCb = fn; },
    dispose() { window.removeEventListener("keydown", onKey); root.remove(); },
  };
}
