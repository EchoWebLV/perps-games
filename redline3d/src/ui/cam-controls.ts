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
// Comic sticker styling: thick near-black ink borders, chunky rounded corners, HARD offset drop
// shadows (no blur), flat bright fills, heavy type. Same layout as before — reskin only.
const CSS = `
.cc-root{position:fixed;right:14px;bottom:16px;z-index:24;display:flex;flex-direction:column;gap:6px;align-items:flex-end;font-family:'Chakra Petch',ui-monospace,monospace;}
.cc-modes{display:flex;gap:6px;background:#241640;border:3px solid #0a0812;border-radius:12px;padding:6px;box-shadow:4px 4px 0 rgba(8,5,16,.9);pointer-events:auto;}
.cc-btn{cursor:pointer;font-size:12px;font-weight:800;letter-spacing:.05em;color:#e6ddff;background:#31204d;border:2px solid #0a0812;border-radius:8px;padding:7px 11px;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-btn.sel{background:#2de2e6;color:#04121a;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
.cc-btn:active{transform:translate(1px,1px);}
.cc-focus{cursor:pointer;font-size:12px;font-weight:800;color:#04121a;background:#ffd166;border:3px solid #0a0812;border-radius:10px;padding:6px 12px;box-shadow:3px 3px 0 rgba(8,5,16,.9);pointer-events:auto;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-focus:active{transform:translate(2px,2px);box-shadow:1px 1px 0 rgba(8,5,16,.9);}
.cc-hint{font-size:9px;color:#8a7db3;font-weight:700;letter-spacing:.05em;}
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
