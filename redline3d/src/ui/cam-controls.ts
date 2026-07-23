// Manual camera control strip for the spectator-race preview (DEV-ONLY, used by
// src/race-preview.ts). Mode buttons AUTO / CHASE / TV / DRONE / FREE (keys 1–5) plus a FOCUS
// cycler (key F) that walks Leader → My Bet → each car. Holds the current mode + focus selection;
// the preview reads mode()/focusSel() each frame and drives the director / OrbitControls. Styling
// matches the bet panel's neon stake chips.
import { onTap } from "./tap";
import { isToonEnabled, setToonEnabled, onToonChanged } from "../render/toon";

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
// Two skins in one sheet. CLASSIC (base, unscoped) is the original dark-neon look. COMIC rules are
// scoped under `body.toon-ui` (toggled by toon.ts): thick ink borders, chunky corners, HARD offset
// shadows (no blur), flat bright fills, heavy type. Same layout either way.
const CSS = `
.cc-root{position:fixed;right:14px;bottom:16px;z-index:24;display:flex;flex-direction:column;gap:6px;align-items:flex-end;font-family:'Chakra Petch',ui-monospace,monospace;}
.cc-modes{display:flex;gap:6px;background:rgba(9,6,22,.8);border:1px solid rgba(122,90,220,.45);border-radius:10px;padding:6px;box-shadow:0 0 20px rgba(120,60,220,.25);pointer-events:auto;}
.cc-btn{cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.06em;color:#c9d6ff;background:rgba(255,255,255,.04);border:1px solid rgba(122,90,220,.45);border-radius:7px;padding:7px 11px;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-btn.sel{background:rgba(39,231,255,.16);border-color:#27e7ff;color:#eaf7ff;box-shadow:0 0 12px rgba(39,231,255,.4);}
.cc-focus{cursor:pointer;font-size:12px;font-weight:700;color:#ffd166;background:rgba(9,6,22,.8);border:1px solid rgba(255,209,102,.5);border-radius:8px;padding:6px 12px;box-shadow:0 0 14px rgba(255,160,40,.2);pointer-events:auto;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-style{cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.06em;color:#9ad7ff;background:rgba(9,6,22,.8);border:1px solid rgba(122,90,220,.5);border-radius:8px;padding:6px 12px;box-shadow:0 0 14px rgba(120,60,220,.2);pointer-events:auto;user-select:none;-webkit-tap-highlight-color:transparent;}
.cc-hint{font-size:9px;color:#6b74a6;letter-spacing:.06em;}

/* ── COMIC skin (active when body.toon-ui) ── */
body.toon-ui .cc-modes{background:#241640;border:3px solid #0a0812;border-radius:12px;box-shadow:4px 4px 0 rgba(8,5,16,.9);}
body.toon-ui .cc-btn{font-weight:800;letter-spacing:.05em;color:#e6ddff;background:#31204d;border:2px solid #0a0812;border-radius:8px;}
body.toon-ui .cc-btn.sel{background:#2de2e6;color:#04121a;box-shadow:2px 2px 0 rgba(8,5,16,.7);}
body.toon-ui .cc-btn:active{transform:translate(1px,1px);}
body.toon-ui .cc-focus{font-weight:800;color:#04121a;background:#ffd166;border:3px solid #0a0812;border-radius:10px;box-shadow:3px 3px 0 rgba(8,5,16,.9);}
body.toon-ui .cc-focus:active{transform:translate(2px,2px);box-shadow:1px 1px 0 rgba(8,5,16,.9);}
body.toon-ui .cc-style{font-weight:800;color:#04121a;background:#8ef0a0;border:3px solid #0a0812;border-radius:10px;box-shadow:3px 3px 0 rgba(8,5,16,.9);}
body.toon-ui .cc-style:active{transform:translate(2px,2px);box-shadow:1px 1px 0 rgba(8,5,16,.9);}
body.toon-ui .cc-hint{color:#8a7db3;font-weight:700;}
`;

export function createCamControls(carCount: number, parent: HTMLElement = document.body): CamControls {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement("style"); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
  }
  const root = document.createElement("div");
  root.className = "cc-root";
  root.innerHTML = `
    <div class="cc-style" title="toggle art style (T)">STYLE · TOON</div>
    <div class="cc-focus" title="cycle focus (F)">◉ Leader</div>
    <div class="cc-modes"></div>
    <div class="cc-hint">1 AUTO · 2 CHASE · 3 TV · 4 DRONE · 5 FREE · F focus · T style</div>`;
  parent.appendChild(root);

  const modesEl = root.querySelector(".cc-modes") as HTMLElement;
  const focusEl = root.querySelector(".cc-focus") as HTMLElement;
  const styleEl = root.querySelector(".cc-style") as HTMLElement;

  // art-style toggle (classic ↔ toon). Label mirrors the current mode and re-syncs on any flip
  // (button, key T, or window.__toonStyle from elsewhere).
  const syncStyleLabel = () => { styleEl.textContent = `STYLE · ${isToonEnabled() ? "TOON" : "CLASSIC"}`; };
  syncStyleLabel();
  onTap(styleEl, () => setToonEnabled(!isToonEnabled()));
  onToonChanged(syncStyleLabel);

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
    else if (k === "t") setToonEnabled(!isToonEnabled());
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
