import type { BuildingKind } from "../core/lobby-layout";

export interface LobbyHud {
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** show "ENTER {NAME}" while in a doorway, or null to clear */
  setPrompt(kind: BuildingKind | null): void;
  /** flash a brief centred message (e.g. the Crate Shop placeholder) */
  toast(msg: string): void;
}

const NAMES: Record<BuildingKind, string> = { garage: "GARAGE", upgrades: "UPGRADES", crates: "CRATES", track: "TRACK" };

const BACK_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`;

/** Minimal lobby overlay: a back/exit button + a centred "ENTER {BUILDING}" prompt + a toast. */
export function createLobbyHud(parent: HTMLElement, onExit: () => void): LobbyHud {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;z-index:9;pointer-events:none";
  el.style.display = "none";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "pe panel";
  back.dataset.exit = "1";
  back.setAttribute("aria-label", "Leave the lobby");
  back.innerHTML = BACK_SVG;
  back.style.cssText = [
    "position:absolute", "top:max(10px,env(safe-area-inset-top))", "left:14px",
    "width:42px", "height:42px", "padding:0", "display:grid", "place-items:center",
    "border-radius:9px", "cursor:pointer", "background:rgba(12,10,26,.74)", "color:var(--cyan)",
  ].join(";");
  back.onclick = onExit;
  el.appendChild(back);

  const hint = document.createElement("div");
  hint.className = "lbl";
  hint.textContent = "hold / W↑ to drive · drag / A D ← → to steer · drive into a building";
  hint.style.cssText = "position:absolute;left:0;right:0;top:64px;text-align:center;color:#b7a9ee;letter-spacing:.06em;text-shadow:0 1px 8px rgba(0,0,0,.8)";
  el.appendChild(hint);

  const prompt = document.createElement("div");
  prompt.dataset.prompt = "1";
  prompt.className = "num";
  prompt.style.cssText = [
    "position:absolute", "left:50%", "bottom:120px", "transform:translateX(-50%)",
    "padding:10px 20px", "border-radius:11px", "font-size:18px", "letter-spacing:.08em",
    "background:rgba(11,8,32,.86)", "border:1px solid var(--cyan)", "color:var(--cyan)",
    "transition:opacity .18s ease",
  ].join(";");
  prompt.style.opacity = "0";
  el.appendChild(prompt);

  const toastEl = document.createElement("div");
  toastEl.dataset.toast = "1";
  toastEl.style.cssText = [
    "position:absolute", "left:50%", "top:50%", "transform:translate(-50%,-50%)",
    "padding:12px 22px", "border-radius:12px", "font-size:16px", "letter-spacing:.06em",
    "background:rgba(11,8,32,.92)", "border:1px solid var(--amb,#ffd166)", "color:var(--amb,#ffd166)",
    "text-shadow:0 0 10px rgba(255,209,102,.45)", "transition:opacity .2s ease",
  ].join(";");
  toastEl.style.opacity = "0";
  el.appendChild(toastEl);

  parent.appendChild(el);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    el,
    show() { el.style.display = "block"; },
    hide() { el.style.display = "none"; },
    setPrompt(kind) {
      if (kind) {
        prompt.textContent = "ENTER " + NAMES[kind];
        prompt.style.opacity = "1";
      } else {
        prompt.style.opacity = "0";
      }
    },
    toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 1500);
    },
  };
}
