import { sol } from "../core/money";

/** play-amount ceiling in 0.01-SOL units (0.10 SOL); Six Wheeler's Heavy Load raises it */
export const DEFAULT_PLAY_CAP = 10;
/** step the play amount by ±1 within [1, cap] — also pulls an over-cap value back down */
export const stepPlay = (v: number, delta: 1 | -1, cap: number) => Math.max(1, Math.min(cap, v + delta));

const TEXT_INPUT_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number"]);
/** True only for GENUINE text entry — the sole state where WASD must yield to typing.
 *  A focused range slider (Pink Rod auto-exit), toggle button, checkbox, or a wallet modal's
 *  leftover overlay element is NOT typing: keying driving-suppression off tagName alone left
 *  `document.activeElement` non-body after a modal closed and silently killed the keyboard. */
export const isTextEntry = (el: HTMLElement | null): boolean => {
  if (!el) return false;
  if (el.isContentEditable === true || el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "text").toLowerCase());
  return false;
};

export type DriveKey = "gas" | "brake" | "left" | "right" | "go";
/** Map a key event to its driving action, PHYSICAL key first (e.code) so WASD works on
 *  every keyboard layout — on Bulgarian/AZERTY/Dvorak the physical W types something
 *  else entirely, and matching e.key alone left production WASD dead. e.key stays as
 *  the fallback for arrows, synthetic events, and virtual keyboards that send no code.
 *  Modified chords (cmd/ctrl/alt) are never driving keys — cmd+W must stay "close tab";
 *  pass ignoreModifiers on keyup so a chorded release still clears a held key. */
export const driveKeyOf = (e: KeyboardEvent, ignoreModifiers = false): DriveKey | null => {
  if (!ignoreModifiers && (e.ctrlKey || e.metaKey || e.altKey)) return null;
  switch (e.code) {
    case "KeyW": return "gas";
    case "KeyS": return "brake";
    case "KeyA": return "left";
    case "KeyD": return "right";
    case "Space": case "Enter": case "NumpadEnter": return "go";
  }
  switch (e.key) {
    case "ArrowUp": case "w": case "W": return "gas";
    case "ArrowDown": case "s": case "S": return "brake";
    case "ArrowLeft": case "a": case "A": return "left";
    case "ArrowRight": case "d": case "D": return "right";
    case " ": case "Enter": return "go";
  }
  return null;
};

export interface Controls {
  dir(): 1 | -1;
  /** set the LONG/SHORT call externally (e.g. the Clown Car's lane-bet ability) — works live too */
  setDir(d: 1 | -1): void;
  /** Clown Car: keep the call box visible during a live round so it reads out the live direction */
  setLaneMode(on: boolean): void;
  playAmount(): number;
  /** per-car max bet (0.01-SOL units) — clamps the current amount down if the cap shrinks */
  setPlayCap(cap: number): void;
  gas(): boolean;
  brake(): boolean;
  steer(): number; // -1 left, 0, 1 right
  setLive(live: boolean, label: string, warn?: boolean): void;
  /** drain the live button's liquidation gauge: 1 = full margin, 0 = at liquidation */
  setBuffer(buf: number): void;
  onLaunch(cb: () => void): void;
  onCashout(cb: () => void): void;
}

const seg = "background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:8px 9px";
const lab = "display:block;margin-bottom:6px";

export function createControls(ctrlMount: HTMLElement, goMount: HTMLElement, pedalMount: HTMLElement): Controls {
  ctrlMount.innerHTML = `
    <div id="callbox" style="${seg};transition:opacity .5s ease"><span class="lbl" style="${lab}">your call</span>
      <div style="display:flex;gap:7px">
        <div id="long" class="seg long on">▲ Long</div>
        <div id="short" class="seg short">▼ Short</div>
      </div></div>
    <div style="${seg}"><span class="lbl" style="${lab}">play amount</span>
      <div style="display:flex;align-items:center;gap:7px">
        <div id="sdn" class="step">−</div>
        <div id="sval" class="num" style="flex:1;text-align:center;font-size:16px">0.05 SOL</div>
        <div id="sup" class="step">+</div>
      </div></div>`;
  pedalMount.innerHTML = `
    <div class="lbl" style="text-align:center;margin-top:8px;line-height:1.45;opacity:.8">hold road to drive<br>drag · pull back = brake</div>`;
  goMount.innerHTML = `<button id="go" class="cta"><span id="gofill"></span><span id="golabel">GO!</span></button>`;

  const q = (s: string) => (ctrlMount.querySelector(s) || goMount.querySelector(s) || pedalMount.querySelector(s)) as HTMLElement;
  let d: 1 | -1 = 1, playAmount = 5, playCap = DEFAULT_PLAY_CAP, live = false; // 0.01-SOL units → 0.05 SOL default
  let gasOn = false, brakeOn = false, steerL = false, steerR = false;
  let launchCb = () => {}, cashCb = () => {};
  // anti-double-tap: when a round goes live the GO button becomes BAIL in place, so a quick second
  // tap would instantly cash out the round you just opened. Ignore bail taps for a short beat.
  const BAIL_LOCK_MS = 1500;
  let cashLockUntil = 0;
  let lastBuffer = ""; // last --b written by setBuffer (per-frame caller — skip identical writes)
  const long = q("#long"), short = q("#short"), sval = q("#sval"), go = q("#go"),
    golabel = q("#golabel"), gofill = q("#gofill"), callbox = q("#callbox");

  let laneMode = false;
  // apply a direction to the UI (used live by the lane-bet); plain clicks stay idle-only
  const applyDir = (nd: 1 | -1) => {
    d = nd;
    long.classList.toggle("on", nd === 1);
    short.classList.toggle("on", nd === -1);
  };
  const setDir = (nd: 1 | -1) => { if (live) return; applyDir(nd); };
  long.onclick = () => setDir(1);
  short.onclick = () => setDir(-1);
  // the call box hides during a live round — except in lane mode, where it stays
  // visible (but non-interactive) as a live LONG/SHORT readout the lane drives
  const refreshCall = () => {
    callbox.style.opacity = !live || laneMode ? "1" : "0";
    callbox.style.pointerEvents = live ? "none" : "auto";
  };
  q("#sup").onclick = () => { if (!live) { playAmount = stepPlay(playAmount, 1, playCap); sval.textContent = sol(playAmount); } };  // +0.01 up to the car's cap
  q("#sdn").onclick = () => { if (!live) { playAmount = stepPlay(playAmount, -1, playCap); sval.textContent = sol(playAmount); } }; // -0.01 → 0.01 SOL floor
  go.onclick = () => {
    if (live) { if (performance.now() < cashLockUntil) return; cashCb(); } // bail is locked for BAIL_LOCK_MS after launch
    else launchCb();
  };

  // keyboard driving (desktop): W/↑ gas, S/↓ brake, A/D or ←/→ steer, space/enter = go.
  // Touch driving (hold-anywhere) lives on the canvas in main.ts.
  // Only genuine TEXT entry (isTextEntry, above) suppresses driving — a focused range slider,
  // toggle, or a wallet modal's leftover overlay element must NOT kill WASD.
  const typingElsewhere = (e: KeyboardEvent): boolean =>
    isTextEntry(e.target as HTMLElement | null) || isTextEntry(document.activeElement as HTMLElement | null);
  // Capture phase on window: the driving keys are seen BEFORE any overlay/focus-trap that
  // might stopPropagation (a wallet modal's leftover DOM was eating them → "WASD stopped").
  addEventListener("keydown", (e) => {
    if (typingElsewhere(e)) return;
    const dk = driveKeyOf(e);
    if (!dk) return;
    if (dk === "gas") gasOn = true;
    else if (dk === "brake") brakeOn = true;
    else if (dk === "left") steerL = true;
    else if (dk === "right") steerR = true;
    else go.click();
    e.preventDefault();
  }, { capture: true });
  addEventListener("keyup", (e) => {
    const dk = driveKeyOf(e, true); // chorded release must still clear a held key
    if (dk === "gas") gasOn = false;
    else if (dk === "brake") brakeOn = false;
    else if (dk === "left") steerL = false;
    else if (dk === "right") steerR = false;
  }, { capture: true });
  // Losing window focus (alt-tab, a wallet/login modal, an OS prompt) swallows the keyup, so
  // a held key latches ON — the car then drives itself or ignores new input ("controls stuck").
  // Clear all key state whenever focus or visibility is lost.
  const clearKeys = () => { gasOn = false; brakeOn = false; steerL = false; steerR = false; };
  addEventListener("blur", clearKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearKeys(); });

  return {
    dir: () => d,
    setDir: applyDir,
    setLaneMode(on: boolean) { laneMode = on; refreshCall(); },
    playAmount: () => playAmount,
    setPlayCap(cap: number) {
      playCap = cap;
      if (playAmount > playCap) { playAmount = playCap; sval.textContent = sol(playAmount); } // cap shrank → pull the bet down
    },
    gas: () => gasOn,
    brake: () => brakeOn,
    steer: () => (steerR ? 1 : 0) - (steerL ? 1 : 0),
    setLive(l, label, warn) {
      if (l && !live) cashLockUntil = performance.now() + BAIL_LOCK_MS; // just went live → lock bail for a beat
      live = l;
      // per-frame caller (live payout label): skip the text write when unchanged. The rest of
      // the body must still run every call — `locked` un-dims on a TIMER, not on an arg change.
      if (golabel.textContent !== label) golabel.textContent = label;
      // the LIVE button becomes the liquidation gauge; idle is the green GO!
      go.classList.toggle("gauge", l);
      go.classList.toggle("warn", !!(l && warn)); // red glow when losing / near liq
      // dim + un-press the bail button during the brief post-launch lock (anti double-tap feedback)
      const locked = l && performance.now() < cashLockUntil;
      go.style.opacity = locked ? "0.5" : "";
      go.style.cursor = locked ? "not-allowed" : "";
      if (!l) { gofill.style.setProperty("--b", "100%"); lastBuffer = "100%"; } // reset the fill for next round (keep the cache honest)
      // long/short fades out for the live round (kept as a live readout in lane mode)
      refreshCall();
    },
    setBuffer(buf) {
      const b = Math.max(0, Math.min(1, buf));
      const v = (b * 100).toFixed(1) + "%";
      if (v !== lastBuffer) { lastBuffer = v; gofill.style.setProperty("--b", v); } // per-frame caller — write on change
    },
    onLaunch: (cb) => (launchCb = cb),
    onCashout: (cb) => (cashCb = cb),
  };
}
