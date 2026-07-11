import type { PresenceEmoteKind } from "../core/presence";
import { onTap } from "./tap";

export type PresenceState = "offline" | "connecting" | "live";

export interface PresenceHud {
  setVisible(visible: boolean): void;
  setState(state: PresenceState, count: number): void;
  pulse(kind: PresenceEmoteKind): void;
}

/** Lobby-only presence readout with a centered status and right-side emote controls. */
export function createPresenceHud(
  parent: HTMLElement,
  onEmote: (kind: PresenceEmoteKind) => void,
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

  const rail = document.createElement("div");
  rail.id = "presence-emotes";
  rail.dataset.presenceEmotes = "1";
  rail.style.cssText = [
    "position:absolute",
    "top:calc(max(10px,env(safe-area-inset-top)) + 50px)",
    "right:max(12px,env(safe-area-inset-right))",
    "z-index:7",
    "display:none",
    "flex-direction:column",
    "gap:6px",
    "pointer-events:none",
  ].join(";");
  rail.style.display = "none";

  const defs = [
    { kind: "laugh", glyph: "😂", label: "Send laugh emote", color: "#ffd166" },
    { kind: "fire", glyph: "🔥", label: "Send fire emote", color: "#ff7a3d" },
    { kind: "skull", glyph: "💀", label: "Send skull emote", color: "#d6c7ff" },
  ] as const;
  const buttons = new Map<PresenceEmoteKind, HTMLButtonElement>();
  const pulseTimers = new Map<PresenceEmoteKind, ReturnType<typeof setTimeout>>();

  const pulse = (kind: PresenceEmoteKind) => {
    const button = buttons.get(kind);
    if (!button) return;
    const previous = pulseTimers.get(kind);
    if (previous) clearTimeout(previous);
    button.style.transform = "scale(1.18)";
    button.style.boxShadow = `0 0 22px ${button.dataset.glow}`;
    pulseTimers.set(kind, setTimeout(() => {
      button.style.transform = "scale(1)";
      button.style.boxShadow = `0 0 14px ${button.dataset.glow}`;
      pulseTimers.delete(kind);
    }, 180));
  };

  for (const def of defs) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.liveEmote = def.kind;
    button.dataset.glow = def.color;
    button.setAttribute("aria-label", def.label);
    button.textContent = def.glyph;
    button.style.cssText = [
      "width:42px",
      "height:42px",
      "padding:0",
      `border:1px solid ${def.color}`,
      "border-radius:9px",
      "background:rgba(8,7,19,.82)",
      `color:${def.color}`,
      "cursor:pointer",
      "pointer-events:auto",
      "font:800 20px/1 sans-serif",
      "transform:scale(1)",
      "transition:transform .14s ease,box-shadow .14s ease",
    ].join(";");
    button.style.transform = "scale(1)";
    button.style.boxShadow = `0 0 14px ${def.color}`;
    buttons.set(def.kind, button);
    onTap(button, () => {
      onEmote(def.kind);
      pulse(def.kind);
    });
    rail.appendChild(button);
  }

  parent.appendChild(status);
  parent.appendChild(rail);

  return {
    setVisible(visible) {
      status.style.display = visible ? "block" : "none";
      rail.style.display = visible ? "flex" : "none";
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
    pulse,
  };
}
