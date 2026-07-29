import type { BuildingKind } from "../core/lobby-layout";

export interface LobbyHud {
  el: HTMLElement;
  show(): void;
  hide(): void;
  /** show the building's offer card while inside its entry ring, or null to clear */
  setPrompt(kind: BuildingKind | null): void;
  /** 0..1 fill of the card's auto-open bar (dwell progress inside the ring) */
  setProgress(p: number): void;
  /** flash a brief centred message (e.g. the Crate Shop placeholder) */
  toast(msg: string): void;
}

/** what each building offers, in player terms — shown on the entry-ring card. Partial by design:
 *  "highway" is a parked kind with no storefront left in the plaza, so no doorway can raise it. */
const OFFERS: Partial<Record<BuildingKind, { name: string; desc: string; css: string }>> = {
  garage: { name: "GARAGE", desc: "Your cars — pick your ride", css: "#27e7ff" },
  upgrades: { name: "UPGRADES", desc: "Tune your car — spend coins", css: "#ffd166" },
  crates: { name: "CRATES", desc: "Loot crates — win new cars", css: "#ff39c0" },
  scrapyard: { name: "SCRAPYARD", desc: "Collect scrap — coming soon", css: "#d94a2b" },
  track: { name: "TRACK", desc: "The main event — race the live price", css: "#14f195" },
  race: { name: "RACE", desc: "Bet the field — real SOL", css: "#ff2d55" },
};

/** Minimal strip overlay: a centred "ENTER {BUILDING}" prompt + a toast. The strip is the home
 *  world — the full betting HUD stays visible over it, so there's no exit button and no driving
 *  hint of its own (the pedal caption under the tach covers the controls). */
export function createLobbyHud(parent: HTMLElement): LobbyHud {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;z-index:9;pointer-events:none";
  el.style.display = "none";

  // offer card: shown while the car sits inside a building's entry ring. Names the building,
  // says what it offers, and fills a thin bar as the auto-open dwell counts down. Anchored
  // high enough to clear the bet ticket + GO stack that lives along the bottom of the strip.
  const prompt = document.createElement("div");
  prompt.dataset.prompt = "1";
  prompt.style.cssText = [
    "position:absolute", "left:50%", "bottom:max(46%,330px)", "transform:translateX(-50%)",
    "min-width:250px", "padding:12px 22px 14px", "border-radius:13px", "text-align:center",
    "background:rgba(11,8,32,.9)", "border:1px solid var(--cyan)",
    "box-shadow:0 0 22px rgba(39,231,255,.22)", "transition:opacity .18s ease",
  ].join(";");
  prompt.style.opacity = "0";

  const promptName = document.createElement("div");
  promptName.dataset.pname = "1";
  promptName.className = "num";
  promptName.style.cssText = "font-size:20px;letter-spacing:.12em;color:var(--cyan);text-shadow:0 0 12px currentColor";
  prompt.appendChild(promptName);

  const promptDesc = document.createElement("div");
  promptDesc.dataset.pdesc = "1";
  promptDesc.className = "lbl";
  promptDesc.style.cssText = "margin-top:4px;font-size:12.5px;letter-spacing:.05em;color:#cfc4f5";
  prompt.appendChild(promptDesc);

  const promptTrack = document.createElement("div");
  promptTrack.style.cssText = "margin-top:9px;height:3px;border-radius:2px;background:rgba(255,255,255,.14);overflow:hidden";
  const promptFill = document.createElement("div");
  promptFill.dataset.pfill = "1";
  promptFill.style.cssText = "height:100%;width:0%;border-radius:2px;background:var(--cyan);transition:width .1s linear";
  promptTrack.appendChild(promptFill);
  prompt.appendChild(promptTrack);

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
  let curKind: BuildingKind | null = null;
  return {
    el,
    show() { el.style.display = "block"; },
    hide() { el.style.display = "none"; },
    setPrompt(kind) {
      if (kind === curKind) return; // called every frame — only touch the DOM on change
      curKind = kind;
      const o = kind ? OFFERS[kind] : undefined;
      if (o) {
        promptName.textContent = o.name;
        promptName.style.color = o.css;
        promptDesc.textContent = o.desc;
        prompt.style.borderColor = o.css;
        prompt.style.boxShadow = `0 0 22px ${o.css}38`;
        promptFill.style.background = o.css;
        prompt.style.opacity = "1";
      } else {
        prompt.style.opacity = "0";
        promptFill.style.width = "0%";
      }
    },
    setProgress(p) {
      promptFill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    },
    toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 1500);
    },
  };
}
