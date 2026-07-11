import { onTap } from "./tap";

export type PresenceState = "offline" | "connecting" | "live";

export interface PresenceHud {
  setVisible(visible: boolean): void;
  setState(state: PresenceState, count: number): void;
  pulse(): void;
}

/** Small lobby-only presence readout with one local emote control. */
export function createPresenceHud(parent: HTMLElement, onEmote: () => void): PresenceHud {
  const root = document.createElement("div");
  root.style.cssText = [
    "position:absolute",
    "top:max(10px,env(safe-area-inset-top))",
    "right:max(12px,env(safe-area-inset-right))",
    "z-index:9",
    "display:none",
    "align-items:center",
    "gap:7px",
    "pointer-events:none",
  ].join(";");
  root.style.display = "none";

  const count = document.createElement("div");
  count.dataset.liveCount = "1";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  count.setAttribute("aria-atomic", "true");
  count.style.cssText = [
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
  count.textContent = "LIVE OFFLINE";
  root.appendChild(count);

  const emote = document.createElement("button");
  emote.dataset.liveEmote = "1";
  emote.setAttribute("type", "button");
  emote.setAttribute("aria-label", "Send spark");
  emote.textContent = "⚡";
  emote.style.cssText = [
    "width:32px",
    "height:32px",
    "padding:0",
    "border:1px solid rgba(255,209,102,.52)",
    "border-radius:9px",
    "background:rgba(8,7,19,.82)",
    "box-shadow:0 0 14px rgba(255,209,102,.18)",
    "color:#ffd166",
    "cursor:pointer",
    "pointer-events:auto",
    "font:800 15px/1 'Chakra Petch',ui-monospace,monospace",
    "transform:scale(1)",
    "transition:transform .14s ease,box-shadow .14s ease",
  ].join(";");
  emote.style.transform = "scale(1)";
  root.appendChild(emote);
  parent.appendChild(root);

  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  const pulse = () => {
    if (pulseTimer) clearTimeout(pulseTimer);
    emote.style.transform = "scale(1.18)";
    emote.style.boxShadow = "0 0 22px rgba(255,209,102,.72)";
    pulseTimer = setTimeout(() => {
      emote.style.transform = "scale(1)";
      emote.style.boxShadow = "0 0 14px rgba(255,209,102,.18)";
      pulseTimer = undefined;
    }, 180);
  };

  onTap(emote, () => {
    onEmote();
    pulse();
  });

  return {
    setVisible(visible) {
      root.style.display = visible ? "flex" : "none";
    },
    setState(state, liveCount) {
      if (state === "live") {
        count.textContent = `LIVE ${liveCount}`;
        count.style.color = "#2ee6a6";
        return;
      }
      count.textContent = state === "connecting" ? "CONNECTING" : "LIVE OFFLINE";
      count.style.color = state === "connecting" ? "#ffd166" : "#8a8aa0";
    },
    pulse,
  };
}
