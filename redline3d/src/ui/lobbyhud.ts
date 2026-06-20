import type { Asset } from "../core/lobby-layout";

export interface LobbyHud {
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** show "ENTER {NAME}" while in a doorway, or null to clear */
  setPrompt(asset: Asset | null): void;
}

const NAMES: Record<Asset, string> = { SOL: "SOLANA", BTC: "BITCOIN", ETH: "ETHEREUM" };

const BACK_SVG =
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>`;

/** Minimal lobby overlay: a back/exit button + a centred "ENTER {MARKET}" prompt. */
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
  hint.textContent = "hold / W↑ to drive · drag / A D ← → to steer · reach a building to enter";
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

  parent.appendChild(el);

  return {
    el,
    show() { el.style.display = "block"; },
    hide() { el.style.display = "none"; },
    setPrompt(asset) {
      if (asset) {
        prompt.textContent = "ENTER " + NAMES[asset];
        prompt.style.opacity = "1";
      } else {
        prompt.style.opacity = "0";
      }
    },
  };
}
