import type { PresenceEmoteKind } from "../core/presence";

export type PresenceState = "offline" | "connecting" | "live";

export interface PresenceHud {
  setVisible(visible: boolean): void;
  setState(state: PresenceState, count: number): void;
  pulse(kind: PresenceEmoteKind): void;
}

/** Lobby-only presence readout. Emote buttons were emoji and are gone — home is the side control. */
export function createPresenceHud(
  parent: HTMLElement,
  _onEmote: (kind: PresenceEmoteKind) => void,
): PresenceHud {
  const status = document.createElement("div");
  status.dataset.presenceStatus = "1";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.style.cssText = [
    "position:absolute",
    "top:max(10px,env(safe-area-inset-top))",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:7",
    "display:none",
    "pointer-events:none",
    "padding:7px 10px",
    "border:1px solid rgba(46,230,166,.42)",
    "border-radius:9px",
    "background:rgba(8,7,19,.82)",
    "box-shadow:0 0 14px rgba(46,230,166,.16)",
    "color:#2ee6a6",
    "font:800 10px/1 'Chakra Petch',ui-monospace,monospace",
    "letter-spacing:.1em",
    "text-shadow:0 0 8px currentColor",
  ].join(";");
  status.style.display = "none";
  status.textContent = "LIVE OFFLINE";

  parent.appendChild(status);

  return {
    setVisible(visible) {
      status.style.display = visible ? "block" : "none";
    },
    setState(state, liveCount) {
      if (state === "live") {
        status.textContent = `LIVE ${liveCount}`;
        status.style.color = "#2ee6a6";
        return;
      }
      status.textContent = state === "connecting" ? "CONNECTING" : "LIVE OFFLINE";
      status.style.color = state === "connecting" ? "#ffd166" : "#8a8aa0";
    },
    pulse() { /* HUD emotes removed — 3D ghosts can still pulse via the lobby renderer */ },
  };
}
