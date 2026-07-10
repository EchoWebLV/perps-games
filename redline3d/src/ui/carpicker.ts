import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TIERS, tierOf, type Rarity } from "../core/rarity";
import { onTap } from "./tap";

/** a car's special ability id; drives in-game effects when that card is selected */
export type CarAbility = "laneBet" | "nitro" | "rainbow" | "skull" | "pinkRod" | "sixWheeler" | "cartRod" | "flux" | "swerve" | "slots" | "airbag" | "magnet";
/** card-face display of the car's power (the ability shown on the card) */
export interface CarPower { name: string; desc: string; icon: string }
export interface CarOption {
  name: string; url: string; scale?: number; yaw?: number;
  ability?: CarAbility; power?: CarPower;
  baseLev?: number;         // car's base max leverage (raises the dial ceiling, e.g. Cybertruck 1500)
  rarity?: Rarity;          // collectible tier 1–5 (Common→Legendary); colored gems on the card
  pool?: boolean;           // false → out of the crate drop pool (free Solana Paper, benched cars)
  locked?: boolean;         // not yet owned → shown sealed in the collection
  comingSoon?: boolean;     // ability still in the shop → card shown taped off, can't be picked
}
export interface Garage {
  /** the wrap element (hamburger button + overlay) — lets the lobby toggle its chrome */
  el: HTMLElement;
  /** while a round is live: the menu stays open, but cars can't be switched */
  setBusy(busy: boolean): void;
  /** open the overlay straight to the garage (car collection) view — used by the lobby Garage building */
  openGarage(): void;
  /** unlock a car in the collection after a crate pull — flips its card from LOCKED to owned + renders its art */
  grant(name: string): void;
  /** the menu/garage/help overlay is on screen (a GO press must not launch behind it) */
  isOpen(): boolean;
  /** cruise chrome: lift the hamburger to the top corner (the price chip's slot is empty
   *  on the strip); false drops it back to its usual row under the racing HUD */
  setMenuTop(on: boolean): void;
  /** showroom (drive-in garage): translucent backdrop + right-anchored panel so the 3D garage
   *  shows behind the collection cards. off restores the opaque strip/hamburger overlay. */
  setShowroom(on: boolean): void;
}

const MODEL_YAW = Math.PI;       // base facing (matches the in-game car)
const HERO_YAW = -0.6;           // 3/4 pose for the captured card art
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// neon line-icons (no emoji) — stroked, inherit currentColor
const ICONS: Record<string, string> = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.4 2"/>',
  shield: '<path d="M12 3l7 2.5v5.5c0 4.2-3 7-7 8-4-1-7-3.8-7-8V5.5L12 3z"/>',
  flame: '<path d="M13 3c.6 3-2.4 4.2-2.4 7.2a2.2 2.2 0 0 0 4.3 0c0-.6-.1-1.1-.3-1.6 1.5 1 2.4 2.6 2.4 4.4a5 5 0 0 1-10 0C6.6 9 10 7 13 3z"/>',
  magnet: '<path d="M7 3v8a5 5 0 0 0 10 0V3"/><path d="M7 7h3M14 7h3"/>',
  chute: '<path d="M3 11a9 9 0 0 1 18 0H3z"/><path d="M3 11l9 9 9-9M8.5 11l3.5 9M15.5 11l-3.5 9"/>',
  swap: '<path d="M4 9h13M14 6l3 3-3 3"/><path d="M20 15H7M10 18l-3-3 3-3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  car: '<path d="M4 13l1.6-4.2A2.5 2.5 0 0 1 8 7h8a2.5 2.5 0 0 1 2.4 1.8L20 13v5h-2.4v-1.6h-11.2V18H4z"/><circle cx="7.6" cy="14.8" r="1.4"/><circle cx="16.4" cy="14.8" r="1.4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1.1.9-1.1 1.7"/><path d="M12 16.4h.01"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  level: '<path d="M6 13l6-6 6 6"/><path d="M6 18l6-6 6 6"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 12H9"/><path d="M13 8l4 4-4 4"/>',
  skull: '<path d="M12 3c-4.4 0-7 3-7 6.6 0 2.3 1.2 3.5 2 4.3V16a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 17 15.9v-2c.8-.8 2-2 2-4.3C19 6 16.4 3 12 3Z"/><circle cx="9.3" cy="10.2" r="1.7"/><circle cx="14.7" cy="10.2" r="1.7"/><path d="M10 17.5v2M12 17.5v2.2M14 17.5v2"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  weight: '<rect x="9.5" y="4" width="5" height="3.2" rx="1"/><path d="M9.8 7.2L5.6 18a1.6 1.6 0 0 0 1.5 2.2h9.8a1.6 1.6 0 0 0 1.5-2.2L14.2 7.2"/><path d="M9 15.5h6"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6l3.2 4.4-3.2 4.4-3.2-4.4z"/>',
  swerve: '<path d="M5 19c7 0 3-7 9-7h5.5"/><path d="M16.5 8.5L20 12l-3.5 3.5"/>',
  bell: '<path d="M12 3.5a5.5 5.5 0 0 1 5.5 5.5v3.6l1.7 2.9H4.8l1.7-2.9V9A5.5 5.5 0 0 1 12 3.5z"/><path d="M10.3 18.5a1.8 1.8 0 0 0 3.4 0"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18 4.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>',
};
const icon = (id: string, size = 15) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ""}</svg>`;
const backIcon = (size: number) => icon("chevron", size).replace('d="M9 6l6 6-6 6"', 'd="M15 6l-6 6 6 6"');
// rarity pips: count = tier (1–5), each colored by its tier (gray→green→blue→purple→gold);
// 0 renders nothing (locked cards show no pips).
const gems = (r: number) => {
  if (!r) return "";
  const c = tierOf(r).color;
  return Array.from({ length: r }, () => `<span class="gem on" style="background:${c};box-shadow:0 0 5px ${c}cc"></span>`).join("");
};

const hudDisplayBeforeMenu = new WeakMap<HTMLElement, string>();

export function setHudMenuMode(parent: HTMLElement, menuRoot: HTMLElement, open: boolean): void {
  for (const child of Array.from(parent.children) as HTMLElement[]) {
    if (child === menuRoot) continue;
    if (open) {
      if (!hudDisplayBeforeMenu.has(child)) hudDisplayBeforeMenu.set(child, child.style.display);
      child.style.display = "none";
    } else {
      child.style.display = hudDisplayBeforeMenu.get(child) ?? "";
      hudDisplayBeforeMenu.delete(child);
    }
  }
}

interface Card { art: HTMLImageElement; spinner: HTMLElement; locked: boolean; }

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .gpanel{width:min(384px,94vw);max-height:100%;padding:15px;display:flex;flex-direction:column;gap:13px;
      background:rgba(12,10,26,.9);border-color:rgba(132,150,224,.28);pointer-events:auto}
    /* drive-in showroom: translucent so the 3D garage shows behind the cards */
    .gover-showroom{background:rgba(6,4,16,.42)!important;backdrop-filter:blur(1px)!important;-webkit-backdrop-filter:blur(1px)!important}
    /* landscape → a side panel on the right (car sits left) */
    @media (orientation:landscape){ .gover-showroom{justify-content:flex-end!important} }
    /* portrait (the mobile game) → a bottom sheet so the hero car owns the top third */
    @media (orientation:portrait){
      .gover-showroom{align-items:flex-end!important;justify-content:center!important;padding:0!important}
      .gover-showroom .gpanel{width:100%!important;max-width:none!important;max-height:66vh!important;
        border-radius:20px 20px 0 0;padding-bottom:max(15px,env(safe-area-inset-bottom));
        box-shadow:0 -18px 44px -12px rgba(0,0,0,.8)}
    }
    .ghead{display:flex;align-items:center;gap:10px}
    .ghead .lbl{flex:1}
    .gicon-btn{display:grid;place-items:center;width:30px;height:30px;border:0;background:transparent;cursor:pointer;color:var(--mut);border-radius:8px}
    .gicon-btn:hover{color:var(--ink);background:rgba(255,255,255,.06)}
    .gmenu{display:flex;flex-direction:column;gap:10px}
    .gmenu-item{display:flex;align-items:center;gap:13px;padding:14px;border-radius:12px;cursor:pointer;text-align:left;
      color:var(--ink);background:rgba(18,14,40,.72);border:1px solid rgba(132,150,224,.24);
      transition:transform .1s ease,border-color .15s,background .15s}
    .gmenu-item:hover{border-color:var(--cyan);background:rgba(30,24,62,.82);transform:translateX(3px)}
    .gmenu-ic{display:flex;color:var(--cyan);filter:drop-shadow(0 0 6px rgba(39,231,255,.55))}
    .gmenu-tx{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
    .gmenu-tx b{font:700 14px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em}
    .gmenu-tx small{font:500 10px/1.2 'Chakra Petch',ui-monospace,monospace;color:var(--mut)}
    .gmenu-arr{display:flex;color:var(--mut)}
    .gmenu-item.locked{cursor:not-allowed;filter:grayscale(.72) brightness(.66);border-color:rgba(132,150,224,.16)}
    .gmenu-item.locked:hover{border-color:rgba(132,150,224,.16);background:rgba(18,14,40,.72);transform:none}
    .gmenu-item.locked .gmenu-arr{color:rgba(220,225,255,.82)}
    .gbusy{display:flex;align-items:center;gap:7px;margin:0 6px;padding:7px 10px;border-radius:8px;
      background:rgba(255,77,109,.12);border:1px solid rgba(255,77,109,.42);color:#ff9aa6;
      font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
    /* audio volume faders (Music / SFX) — match the menu items' dark card + cyan accent */
    .gaudio{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;
      background:rgba(18,14,40,.72);border:1px solid rgba(132,150,224,.24)}
    .gaudio .gmenu-ic{color:var(--cyan);filter:drop-shadow(0 0 6px rgba(39,231,255,.55))}
    .gaudio-tx{display:flex;flex-direction:column;gap:3px;min-width:62px}
    .gaudio-tx b{font:700 14px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;color:var(--ink)}
    .gaudio-val{font:600 10px/1.2 'Chakra Petch',ui-monospace,monospace;color:var(--cyan);letter-spacing:.06em}
    .gaudio-range{flex:1;-webkit-appearance:none;appearance:none;height:5px;border-radius:999px;margin:0;
      background:rgba(132,150,224,.24);outline:none;cursor:pointer}
    .gaudio-range::-webkit-slider-runnable-track{height:5px;border-radius:999px;background:transparent}
    .gaudio-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;
      border-radius:50%;background:var(--cyan);box-shadow:0 0 8px rgba(39,231,255,.7),0 1px 3px rgba(0,0,0,.5);cursor:pointer}
    .gaudio-range::-moz-range-track{height:5px;border-radius:999px;background:rgba(132,150,224,.24)}
    .gaudio-range::-moz-range-progress{height:5px;border-radius:999px;background:linear-gradient(90deg,#2775ca,var(--cyan))}
    .gaudio-range::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--cyan);
      box-shadow:0 0 8px rgba(39,231,255,.7)}
    .ggrid.locked .gcard:not(.locked){cursor:not-allowed}
    .ggrid.locked .gcard:not(.locked):hover{transform:none;box-shadow:0 9px 22px rgba(0,0,0,.55)}
    .ggrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:13px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
      min-height:0;max-height:min(72vh,560px);padding:16px 6px 16px;
      scrollbar-width:thin;scrollbar-color:rgba(132,150,224,.45) transparent;-webkit-overflow-scrolling:touch}
    .ggrid::-webkit-scrollbar{width:8px}
    .ggrid::-webkit-scrollbar-thumb{background:rgba(132,150,224,.45);border-radius:8px}
    .ggrid::-webkit-scrollbar-track{background:transparent}
    .gcard{position:relative;border-radius:13px;cursor:pointer;padding:9px 8px 7px;isolation:isolate;
      display:flex;flex-direction:column;gap:6px;border:2px solid transparent;
      background:linear-gradient(168deg,#241a63,#3c1d6b 42%,#7d1f6a) padding-box,
        linear-gradient(135deg,#27e7ff,#ff39c0 46%,#ffd166 72%,#27e7ff) border-box;
      box-shadow:0 9px 22px rgba(0,0,0,.55);transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .2s ease}
    .gcard:not(.locked):hover{transform:translateY(-6px) scale(1.045);z-index:6;box-shadow:0 16px 38px rgba(39,231,255,.42)}
    .gcard:not(.locked):active{transform:translateY(-2px) scale(1.02)}
    .gcard.sel{box-shadow:0 0 0 2px var(--cyan),0 12px 32px rgba(39,231,255,.5)}
    .gcard::before{content:"";position:absolute;inset:4px;border:1px solid rgba(255,255,255,.16);border-radius:9px;pointer-events:none;z-index:4}
    .gcard-holo{position:absolute;inset:0;border-radius:11px;pointer-events:none;z-index:3;mix-blend-mode:color-dodge;opacity:.3;
      background:linear-gradient(115deg,transparent 4%,rgba(0,230,255,.75) 22%,rgba(255,0,200,.7) 42%,rgba(255,230,0,.6) 60%,rgba(0,230,255,.75) 80%,transparent 96%);
      background-size:260% 260%;animation:holoShift 6s linear infinite}
    .gcard-holo::after{content:"";position:absolute;inset:0;border-radius:11px;
      background:radial-gradient(58% 48% at var(--gx,50%) var(--gy,0%),rgba(255,255,255,.55),transparent 60%);opacity:0;transition:opacity .2s}
    .gcard:not(.locked):hover .gcard-holo{opacity:.5}
    .gcard:not(.locked):hover .gcard-holo::after{opacity:.55}
    @keyframes holoShift{0%{background-position:0% 50%}100%{background-position:300% 50%}}
    .gtitle{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:1px 3px 0;position:relative;z-index:2}
    .gtitle-name{font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.03em;color:#fff;text-transform:uppercase;
      text-shadow:0 0 8px rgba(39,231,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .grarity{display:flex;gap:3px;flex:none}
    .gem{width:6px;height:6px;transform:rotate(45deg);background:rgba(255,255,255,.18);border-radius:1px}
    .gem.on{background:#ffd166;box-shadow:0 0 5px rgba(255,209,102,.85)}
    .godds{display:flex;flex-wrap:wrap;align-items:center;gap:5px 11px;padding:7px 12px 9px;border-bottom:1px solid rgba(255,255,255,.08)}
    .godds-lbl{font:800 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:rgba(216,222,255,.5)}
    .godds-t{display:flex;align-items:center;gap:5px;font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.03em;color:rgba(226,230,255,.86)}
    .godds-t i{width:8px;height:8px;transform:rotate(45deg);border-radius:1px;background:var(--tc);box-shadow:0 0 6px var(--tc)}
    .gcard-win{position:relative;height:116px;border-radius:10px;overflow:hidden;z-index:1;border:1px solid rgba(255,255,255,.2);
      background:radial-gradient(120% 80% at 50% 98%,rgba(39,231,255,.2),rgba(255,57,192,.07) 54%,transparent 78%),
        linear-gradient(150deg,rgba(255,255,255,.2) 0%,rgba(255,255,255,.04) 26%,transparent 44%);
      box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.26),inset 0 3px 7px rgba(255,255,255,.2),inset 0 -10px 16px rgba(0,0,0,.4)}
    .gcard-art{position:absolute;inset:2px;width:calc(100% - 4px);height:calc(100% - 4px);object-fit:contain;z-index:1;opacity:0;transition:opacity .35s ease}
    .gcard-art.on{opacity:1}
    .gcard-win::after{content:"";position:absolute;top:0;left:0;right:0;height:46%;pointer-events:none;z-index:2;
      background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,.04) 70%,transparent);
      border-radius:10px 10px 46%46%/10px 10px 20px 20px}
    .gcard-ld{position:absolute;inset:0;display:grid;place-items:center;z-index:1}
    .gcard-ld i{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.16);border-top-color:var(--cyan);animation:gspin .8s linear infinite}
    @keyframes gspin{to{transform:rotate(360deg)}}
    .gcard-ab{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:8px;position:relative;z-index:2;min-height:34px;
      background:rgba(7,5,18,.62);border:1px solid rgba(39,231,255,.36);box-shadow:inset 0 0 10px rgba(39,231,255,.09)}
    .gcard-ab-ic{display:flex;color:#ffd166;filter:drop-shadow(0 0 5px rgba(255,209,102,.6))}
    .gcard-ab-tx{display:flex;flex-direction:column;min-width:0;gap:2px}
    .gcard-ab-name{font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;color:var(--cyan);text-transform:uppercase}
    .gcard-ab-desc{font:500 8.5px/1.1 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gfoot{display:flex;align-items:center;justify-content:space-between;padding:0 3px 1px;position:relative;z-index:2;
      font:700 8px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em}
    .gfoot-brand{color:#fff;text-shadow:0 0 7px rgba(255,57,192,.85)}
    .gfoot-no{color:rgba(255,255,255,.5);letter-spacing:.1em}
    .gcard.locked{cursor:not-allowed;filter:grayscale(.82) brightness(.52);
      background:linear-gradient(168deg,#1b1830,#241f3a) padding-box,linear-gradient(135deg,#555,#888) border-box}
    .gcard-lock{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:rgba(220,225,255,.85);z-index:1}
    .gcard-lock span{font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.22em}
    /* --- "coming soon" construction tape (Skull now; reused for future cars) --- */
    .gcard.soon{cursor:not-allowed}
    .gcard.soon:hover{transform:none;box-shadow:0 9px 22px rgba(0,0,0,.55)}
    .gcard.soon .gcard-win,.gcard.soon .gcard-ab{filter:grayscale(.62) brightness(.58) contrast(.92)}
    .gcard.soon .gcard-holo{opacity:.1}
    .gcard.soon .gtitle-name{color:rgba(220,225,255,.6);text-shadow:none}
    .gcard-tape{position:absolute;left:-9%;width:118%;height:30px;z-index:7;pointer-events:none;
      display:grid;place-items:center;overflow:hidden;
      background:repeating-linear-gradient(-45deg,#f4c81a 0 13px,#141008 13px 26px);
      border-top:1.5px solid rgba(0,0,0,.55);border-bottom:1.5px solid rgba(0,0,0,.55);
      box-shadow:0 3px 10px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.28),inset 0 -3px 6px rgba(0,0,0,.35)}
    .gcard-tape-txt{font:800 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.18em;color:#140f02;white-space:nowrap;
      text-shadow:0 0 3px #f4c81a,0 1px 0 #f4c81a,0 -1px 0 #f4c81a,1px 0 0 #f4c81a,-1px 0 0 #f4c81a}
    .tape-1{top:43%;transform:translateY(-50%) rotate(-16deg)}
    .tape-2{top:52%;transform:translateY(-50%) rotate(11deg)}
    .tape-3{top:38%;transform:translateY(-50%) rotate(-6deg)}
    /* ---- card detail zoom (tap a card → big collectible card, gold frame + dark interior) ---- */
    .gdetail-scrim{position:fixed;inset:0;z-index:12;display:none;align-items:center;justify-content:center;padding:20px;
      background:rgba(4,3,12,.82);backdrop-filter:blur(3px);perspective:1400px}
    .gdetail-scrim.on{display:flex}
    .gdcard{width:min(330px,90vw);border-radius:20px;padding:9px;position:relative;transform-style:preserve-3d;transition:transform .14s ease;
      background:linear-gradient(135deg,#ffe37a,#dfa42a 40%,#fff1a8 60%,#c9902a);
      box-shadow:0 26px 64px -18px rgba(0,0,0,.9),0 0 26px -8px rgba(255,209,102,.5)}
    .gdcard-face{position:relative;overflow:hidden;border-radius:13px;padding:13px;
      background:radial-gradient(130% 80% at 50% -12%,rgba(39,231,255,.16),transparent 55%),linear-gradient(168deg,#181327,#0d0a1a);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),inset 0 1px 0 rgba(255,255,255,.14)}
    .gdcard-glare{position:absolute;inset:0;z-index:6;pointer-events:none;opacity:0;transition:opacity .2s;mix-blend-mode:soft-light;
      background:radial-gradient(180px 180px at var(--gx,50%) var(--gy,0%),rgba(255,255,255,.4),transparent 60%)}
    .gdcard:hover .gdcard-glare{opacity:1}
    .gdcard-x{position:absolute;top:9px;left:9px;z-index:7;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;
      cursor:pointer;color:#fff;background:rgba(0,0,0,.35)}
    .gdcard-x:hover{background:rgba(0,0,0,.55)}
    .gdcard-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 10px 34px;position:relative;z-index:2}
    .gdcard-name{font:800 20px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.03em;color:#fff;text-shadow:0 0 10px rgba(39,231,255,.55)}
    .gdcard-rar{display:flex;gap:4px}
    .gdcard-rar .gem{width:9px;height:9px}
    .gdcard-tier{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-4px 0 10px 34px;position:relative;z-index:2;
      font:800 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase;text-shadow:0 0 9px currentColor}
    .gdcard-win{position:relative;height:200px;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.18);z-index:1;
      background:radial-gradient(90% 70% at 50% 16%,rgba(255,60,160,.32),transparent 62%),linear-gradient(180deg,#291a4c,#0b0816 74%)}
    .gdcard-win::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(39,231,255,.10) 0 2px,transparent 2px 28px)}
    .gdcard-holo{position:absolute;inset:0;z-index:1;mix-blend-mode:screen;opacity:.16;
      background:conic-gradient(from 0deg,#ff3ca0,#ffd84d,#3cff9e,#3cc8ff,#b06bff,#ff3ca0)}
    .gdcard-shine{position:absolute;inset:-40% -60%;z-index:3;pointer-events:none;
      background:linear-gradient(115deg,transparent 44%,rgba(255,255,255,.22) 50%,transparent 56%);animation:gdshine 4.2s ease-in-out infinite}
    @keyframes gdshine{0%,100%{transform:translateX(-32%)}50%{transform:translateX(32%)}}
    .gdcard-art{position:absolute;inset:8px;width:calc(100% - 16px);height:calc(100% - 16px);object-fit:contain;z-index:4;filter:drop-shadow(0 7px 15px rgba(0,0,0,.7));transition:opacity .4s ease}
    .gdcard-art.hide{opacity:0}
    .gdcard-3d{position:absolute;inset:8px;width:calc(100% - 16px);height:calc(100% - 16px);z-index:5;opacity:0;transition:opacity .45s ease;pointer-events:none}
    .gdcard-3d.on{opacity:1}
    .gdcard-ab{display:flex;align-items:flex-start;gap:10px;margin:12px 0;padding:10px 12px;border-radius:10px;position:relative;z-index:2;
      background:rgba(7,5,18,.55);border:1px solid rgba(39,231,255,.32);box-shadow:inset 0 0 12px rgba(39,231,255,.08)}
    .gdcard-ab-ic{display:flex;color:#ffd166;filter:drop-shadow(0 0 5px rgba(255,209,102,.6));margin-top:1px}
    .gdcard-ab-tx{display:flex;flex-direction:column;gap:3px;min-width:0}
    .gdcard-ab-nm{font:700 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;color:var(--cyan);text-transform:uppercase}
    .gdcard-ab-ds{font:500 11px/1.4 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.72)}
    .gdcard-equip{position:relative;z-index:2;width:100%;padding:12px;border:0;border-radius:10px;cursor:pointer;
      font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;color:#04222b;
      background:linear-gradient(180deg,#5cf0ff,#12c7e6);box-shadow:0 0 18px -4px #27e7ff,inset 0 1px 0 rgba(255,255,255,.6)}
    .gdcard-equip:hover{filter:brightness(1.08)}
    .gdcard-equip.dis{background:rgba(255,77,109,.16);color:#ff9aa6;box-shadow:none;cursor:not-allowed;letter-spacing:.06em}
  `;
  document.head.appendChild(s);
}

/** Game menu → Garage. Cars are rendered ONCE to static card art (light, no live canvas). */
/** A bottom-of-menu volume fader (Music, SFX, …). Value is 0..1, owned by the caller via get/set;
 *  0 = fully off. Rendered as a styled range slider. */
export interface MenuSlider {
  label: string;
  sub?: string;
  glyph?: string;
  get: () => number;      // 0..1
  set: (v: number) => void; // 0..1
}

/** race-level skin picker for the menu — `list()` is the seam the crate-reward system filters later */
export interface WorldPicker {
  list: () => { key: string; name: string; colors: string[]; locked?: boolean }[];
  current: () => string;
  set: (key: string) => void;
}

export interface MenuFeatures {
  showGarageAndUpgrades?: boolean;
  onHistory?: () => void;
}

export function createCarPicker(
  parent: HTMLElement,
  cars: CarOption[],
  onPick: (c: CarOption) => void,
  onUpgrades?: () => void,
  sliders: MenuSlider[] = [],
  onLogout?: () => void,
  onClose?: (reason?: "dismiss" | "chain") => void,
  accountInfo?: () => { label: string; sub: string },
  worlds?: WorldPicker,
  menuFeatures: MenuFeatures = {},
): Garage {
  injectStyles();

  const wrap = document.createElement("div");
  wrap.className = "pe";
  // top rides the same base as hud.ts: base+134 sits 10px under the graph at any inset (144 on desktop)
  wrap.style.cssText = "position:absolute;top:calc(max(10px,env(safe-area-inset-top)) + 134px);right:max(12px,env(safe-area-inset-right));z-index:8;display:block";

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:9", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");

  // showroom (drive-in garage): the `.gover-showroom` class makes the backdrop translucent and
  // re-anchors the panel — a right-side panel in landscape, a bottom sheet in portrait (mobile) —
  // so the rotating car stays visible. off = the opaque strip/hamburger overlay.
  overlay.className = "gover";
  let showroom = false;
  const applyShowroom = () => { overlay.classList.toggle("gover-showroom", showroom); };

  type View = "menu" | "garage" | "worlds";
  let view: View = "menu";

  const menuPanel = document.createElement("div");
  menuPanel.className = "panel gpanel";
  const localRows = menuFeatures.showGarageAndUpgrades === false ? "" : `
      <button class="gmenu-item" data-go="garage"><span class="gmenu-ic">${icon("car", 20)}</span><span class="gmenu-tx"><b>Garage</b><small>your card collection</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
      <button class="gmenu-item" data-act="upgrades"><span class="gmenu-ic">${icon("level", 20)}</span><span class="gmenu-tx"><b>Upgrades</b><small>tune your car</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>`;
  const historyRow = `
      <button class="gmenu-item" data-act="history"><span class="gmenu-ic">${icon("clock", 20)}</span><span class="gmenu-tx"><b>History</b><small>your settled trades</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>`;
  menuPanel.innerHTML =
    `<div class="ghead"><span class="lbl">menu</span><button class="gicon-btn" data-act="close" aria-label="Close">✕</button></div>` +
    `<div class="gmenu">${localRows}${historyRow}
      <button class="gmenu-item" data-act="howto"><span class="gmenu-ic">${icon("help", 20)}</span><span class="gmenu-tx"><b>How to play</b><small>controls &amp; the bet</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
    </div>`;

  // audio on/off toggles (Music / SFX) appended at the bottom of the menu list
  const gmenu = menuPanel.querySelector(".gmenu") as HTMLElement | null;
  // World (race-level skin) picker — opens a sub-view listing every skin
  if (worlds && gmenu) {
    const b = document.createElement("button");
    b.className = "gmenu-item";
    b.dataset.go = "worlds";
    b.innerHTML =
      `<span class="gmenu-ic">${icon("sparkle", 20)}</span>` +
      `<span class="gmenu-tx"><b>World</b><small>race level skin</small></span>` +
      `<span class="gmenu-arr">${icon("chevron", 16)}</span>`;
    gmenu.appendChild(b);
  }
  // audio volume faders (Music / SFX) — a styled range slider per channel; 0 = off
  const sliderEls: { input: HTMLInputElement; val: HTMLElement }[] = [];
  const paintSlider = (input: HTMLInputElement, val: HTMLElement) => {
    const v = +input.value;
    val.textContent = v === 0 ? "off" : v + "%";
    input.style.background = `linear-gradient(90deg,var(--cyan) ${v}%,rgba(132,150,224,.24) ${v}%)`;
  };
  if (sliders.length && gmenu) {
    const sep = document.createElement("div");
    sep.textContent = "audio";
    sep.style.cssText = "margin:8px 4px 2px;font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;color:var(--mut)";
    gmenu.appendChild(sep);
    sliders.forEach((sl) => {
      const row = document.createElement("div");
      row.className = "gaudio";
      row.innerHTML =
        `<span class="gmenu-ic" style="font:700 18px/1 'Chakra Petch',ui-monospace,monospace">${sl.glyph ?? "♪"}</span>` +
        `<span class="gaudio-tx"><b>${sl.label}</b><small class="gaudio-val"></small></span>` +
        `<input type="range" class="gaudio-range" min="0" max="100" step="1" aria-label="${sl.label} volume">`;
      gmenu.appendChild(row);
      const input = row.querySelector(".gaudio-range") as HTMLInputElement;
      const val = row.querySelector(".gaudio-val") as HTMLElement;
      input.value = String(Math.round(clamp01(sl.get()) * 100));
      paintSlider(input, val);
      input.addEventListener("input", () => { sl.set(clamp01(+input.value / 100)); paintSlider(input, val); });
      // keep a slider drag from bubbling to the overlay's click/dismiss delegation
      input.addEventListener("click", (e) => e.stopPropagation());
      sliderEls.push({ input, val });
    });
  }

  // account section — Log out (only for a real signed-in account; dev/guest passes no onLogout)
  if (onLogout && gmenu) {
    const sep = document.createElement("div");
    sep.textContent = "account";
    sep.style.cssText = "margin:8px 4px 2px;font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;color:var(--mut)";
    gmenu.appendChild(sep);
    const b = document.createElement("button");
    b.className = "gmenu-item";
    b.dataset.act = "logout";
    b.innerHTML =
      `<span class="gmenu-ic">${icon("logout", 20)}</span>` +
      `<span class="gmenu-tx"><b data-acclabel="1">Log out</b><small data-accsub="1">sign out of your account</small></span>` +
      `<span class="gmenu-arr">${icon("chevron", 16)}</span>`;
    gmenu.appendChild(b);
  }

  const refreshMenu = () => {
    // the account row reads out WHO is riding and what the action is (guest → "Sign in",
    // signed-in → "Log out") — refreshed on every menu open
    if (accountInfo) {
      const info = accountInfo();
      const label = menuPanel.querySelector("[data-acclabel]") as HTMLElement | null;
      const sub = menuPanel.querySelector("[data-accsub]") as HTMLElement | null;
      if (label) label.textContent = info.label;
      if (sub) sub.textContent = info.sub;
    }
    // reflect the current Music/SFX volumes (they can change elsewhere) on every menu open
    sliders.forEach((sl, i) => {
      const el = sliderEls[i];
      if (!el) return;
      el.input.value = String(Math.round(clamp01(sl.get()) * 100));
      paintSlider(el.input, el.val);
    });
  };

  // ---- world (race-level skin) picker sub-view ----
  const worldsPanel = document.createElement("div");
  worldsPanel.className = "panel gpanel";
  worldsPanel.style.display = "none";
  worldsPanel.innerHTML =
    `<div class="ghead"><button class="gicon-btn" data-act="back" aria-label="Back">${backIcon(18)}</button><span class="lbl">world · level skin</span><button class="gicon-btn" data-act="close" aria-label="Close">✕</button></div>` +
    `<div class="gmenu" data-worlds-list></div>`;
  const renderWorlds = () => {
    if (!worlds) return;
    const list = worldsPanel.querySelector("[data-worlds-list]") as HTMLElement;
    const cur = worlds.current();
    list.innerHTML = worlds.list().map((w) => {
      const locked = !!w.locked;                 // unowned skins show sealed (like a locked card), not hidden
      const active = !locked && w.key === cur;
      const sw = `linear-gradient(135deg, ${w.colors.join(", ")})`;
      return `<button class="gmenu-item${locked ? " locked" : ""}" data-world="${w.key}"${active ? ' style="border-color:var(--cyan);background:rgba(39,231,255,.10)"' : ""}>` +
        `<span class="gmenu-ic" style="width:22px;height:22px;border-radius:6px;background:${sw};box-shadow:0 0 9px ${w.colors[w.colors.length - 1]}"></span>` +
        `<span class="gmenu-tx"><b>${w.name}</b><small>${locked ? "locked · unlock from crates" : active ? "active" : "tap to switch"}</small></span>` +
        `<span class="gmenu-arr"${locked ? "" : ' style="color:var(--cyan);font:700 15px/1 \'Chakra Petch\',ui-monospace,monospace"'}>${locked ? icon("lock", 15) : active ? "✓" : ""}</span>` +
        `</button>`;
    }).join("");
  };

  const garagePanel = document.createElement("div");
  garagePanel.className = "panel gpanel";
  garagePanel.style.display = "none";
  const garageHead = document.createElement("div");
  garageHead.className = "ghead";
  garageHead.innerHTML =
    `<button class="gicon-btn" data-act="back" aria-label="Back">${backIcon(18)}</button>` +
    `<span class="lbl">garage · your collection</span>` +
    `<button class="gicon-btn" data-act="close" aria-label="Close">✕</button>`;
  garagePanel.appendChild(garageHead);
  // rarity legend — a colour key for the gem tiers on the cards (collection info). Crate DROP ODDS
  // are deliberately NOT shown here: they belong at the point of purchase (the crate shop), never the
  // garage/your-collection. Keep the tier names + colours; drop every percentage.
  const rarityLegend = document.createElement("div");
  rarityLegend.className = "godds";
  rarityLegend.innerHTML = `<span class="godds-lbl">rarity</span>` + TIERS.map((t) =>
    `<span class="godds-t" style="--tc:${t.color}"><i></i>${t.name.charAt(0) + t.name.slice(1).toLowerCase()}</span>`).join("");
  garagePanel.appendChild(rarityLegend);
  const busyNote = document.createElement("div");
  busyNote.className = "gbusy";
  busyNote.style.display = "none";
  busyNote.innerHTML = `${icon("lock", 13)}<span>round live — cash out to switch cars</span>`;
  garagePanel.appendChild(busyNote);
  const grid = document.createElement("div");
  grid.className = "ggrid";
  garagePanel.appendChild(grid);

  let busy = false;
  const updateBusyUI = () => { busyNote.style.display = busy ? "flex" : "none"; grid.classList.toggle("locked", busy); };

  const cards: Card[] = [];
  let selectedEl: HTMLElement | null = null;
  const select = (el: HTMLElement, c: CarOption) => {
    if (c.locked || c.comingSoon) return; // taped-off cards aren't drivable yet
    if (busy) { busyNote.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 240 }); return; }
    if (selectedEl) selectedEl.classList.remove("sel");
    el.classList.add("sel");
    selectedEl = el;
    onPick(c);
  };

  let tapeSeen = 0; // cycles the 3 tape angles across taped cards so no two adjacent match
  // (re)paint a card element for car `c` — locked (sealed) vs unlocked (art + ability). Extracted
  // so grant() can flip a card from LOCKED to owned after a crate pull without duplicating the build.
  const fillCard = (card: HTMLElement, c: CarOption, i: number): Card => {
    card.className = "gcard" + (c.locked ? " locked" : "") + (c.comingSoon ? " soon" : "");
    const series = `${String(i + 1).padStart(2, "0")} / ${String(cars.length).padStart(2, "0")}`;
    const rarity = c.rarity ?? 1;
    if (c.locked) {
      card.innerHTML =
        `<div class="gtitle"><span class="gtitle-name" style="color:var(--mut)">${c.name}</span><span class="grarity">${gems(0)}</span></div>` +
        `<div class="gcard-win"><div class="gcard-lock">${icon("lock", 30)}<span>LOCKED</span></div></div>` +
        `<div class="gcard-ab"><span class="gcard-ab-ic">${icon("lock")}</span><span class="gcard-ab-tx"><span class="gcard-ab-name" style="color:var(--mut)">Locked</span><span class="gcard-ab-desc">unlock to reveal</span></span></div>` +
        `<div class="gfoot"><span class="gfoot-brand" style="color:var(--mut);text-shadow:none">PERPS RAIDER</span><span class="gfoot-no">${series}</span></div>`;
    } else {
      const p = c.power;
      const ability = p
        ? `<span class="gcard-ab-ic">${icon(p.icon)}</span><span class="gcard-ab-tx"><span class="gcard-ab-name">${p.name}</span><span class="gcard-ab-desc">${p.desc}</span></span>`
        : `<span class="gcard-ab-tx"><span class="gcard-ab-name" style="color:var(--mut)">Stock</span><span class="gcard-ab-desc">no special ability</span></span>`;
      card.innerHTML =
        `<div class="gcard-holo"></div>` +
        `<div class="gtitle"><span class="gtitle-name">${c.name}</span><span class="grarity">${gems(rarity)}</span></div>` +
        `<div class="gcard-win"><img class="gcard-art" alt="${c.name}"><div class="gcard-ld"><i></i></div></div>` +
        `<div class="gcard-ab">${ability}</div>` +
        `<div class="gfoot"><span class="gfoot-brand">PERPS RAIDER</span><span class="gfoot-no">${series}</span></div>`;
      const holo = card.querySelector(".gcard-holo") as HTMLElement;
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        holo.style.setProperty("--gx", `${((e.clientX - r.left) / r.width) * 100}%`);
        holo.style.setProperty("--gy", `${((e.clientY - r.top) / r.height) * 100}%`);
      });
      if (c.comingSoon) {
        // construction tape stretched across the card: 3 angle variants, cycled so the
        // wall of "coming soon" cards reads varied rather than stamped
        const v = (tapeSeen++ % 3) + 1;
        const tape = document.createElement("div");
        tape.className = `gcard-tape tape-${v}`;
        tape.innerHTML = `<span class="gcard-tape-txt">COMING SOON</span>`;
        card.appendChild(tape);
      }
    }
    const art = card.querySelector(".gcard-art") as HTMLImageElement;
    const spinner = card.querySelector(".gcard-ld") as HTMLElement;
    card.onclick = () => { if (c.locked || c.comingSoon) return; openDetail(c, i, card); };
    return { art, spinner, locked: !!c.locked };
  };
  cars.forEach((c, i) => {
    const card = document.createElement("div");
    cards.push(fillCard(card, c, i));
    grid.appendChild(card);
  });
  // the boot car must be PICKED, not just painted — a class-only "sel" leaves the
  // default card's ability dead until the player re-clicks it in the garage
  const firstOpen = cars.findIndex((c) => !c.locked && !c.comingSoon);
  if (firstOpen >= 0) select(grid.children[firstOpen] as HTMLElement, cars[firstOpen]);

  // ---- render each car to a STATIC image once (no persistent canvas → light + no stuck frames) ----
  let rendered = false;
  const renderArt = () => {
    if (rendered) return;
    rendered = true;
    const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(2);
    r.setSize(300, 224, false);
    const cam = new THREE.PerspectiveCamera(32, 300 / 224, 0.1, 100);
    cam.position.set(1.19, 0.85, 2.25); // framing tuned so the car sits ~20% smaller in the card
    cam.lookAt(0, -0.05, 0);
    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const loader = new GLTFLoader();
    // ONE model in flight at a time: 13 parallel GLB decodes into this second WebGL
    // context was the mobile memory peak (tab-killed Chrome/Safari on phones). The
    // queue drains sequentially and the renderer tears down even if a load errors.
    const queue = cars.map((c, i) => ({ c, i })).filter(({ c }) => !c.locked);
    const next = () => {
      const item = queue.shift();
      if (!item) { env.dispose(); r.dispose(); return; }
      const { c, i } = item;
      loader.load(c.url, (gltf) => {
        const model = gltf.scene;
        model.rotation.y = MODEL_YAW + (c.yaw ?? 0);
        const box = new THREE.Box3().setFromObject(model);
        const sph = box.getBoundingSphere(new THREE.Sphere());
        model.scale.setScalar((1 / (sph.radius || 1)) * (c.scale ?? 1));
        const box2 = new THREE.Box3().setFromObject(model);
        const ctr = box2.getCenter(new THREE.Vector3());
        model.position.set(-ctr.x, -ctr.y, -ctr.z);
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => {
            if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).envMapIntensity = 0.7;
          });
        });
        const scene = new THREE.Scene();
        scene.environment = env;
        scene.add(new THREE.AmbientLight("#8a78ff", 0.85));
        const key = new THREE.DirectionalLight("#27e7ff", 1.7); key.position.set(2.2, 3, 2.4); scene.add(key);
        const rim = new THREE.DirectionalLight("#ff39c0", 1.5); rim.position.set(-2.4, 1.2, -2); scene.add(rim);
        const pivot = new THREE.Group(); pivot.rotation.y = HERO_YAW; pivot.add(model); scene.add(pivot);
        r.render(scene, cam);
        const url = r.domElement.toDataURL("image/png");
        const card = cards[i];
        card.art.src = url;
        card.art.classList.add("on");
        card.spinner.style.display = "none";
        // free the GPU resources for this car
        model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); } });
        next();
      }, undefined, (err) => { console.warn("[garage] GLB failed:", c.url, err); next(); });
    };
    next();
  };

  // ---- card detail zoom: tap a grid card → big collectible card with Equip ----
  const detailScrim = document.createElement("div");
  detailScrim.className = "gdetail-scrim";
  const detailCard = document.createElement("div");
  detailCard.className = "gdcard";
  detailScrim.appendChild(detailCard);
  let detailPoll = 0;

  // ---- lazy live-3D for the OPEN detail card ----
  // one shared renderer/canvas, one model at a time, rAF only while a card is open, model
  // disposed on close. The grid stays static PNGs (25 live models tank mobile); a single open
  // card is cheap. The static PNG shows instantly and the live model fades in over it.
  let live: { canvas: HTMLCanvasElement; renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; pivot: THREE.Group; loader: GLTFLoader } | null = null;
  let liveModel: THREE.Object3D | null = null;
  let liveRaf = 0;
  let liveToken = 0;
  const disposeTree = (root: THREE.Object3D) => root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); }
  });
  const ensureLive = () => {
    if (live) return live;
    const canvas = document.createElement("canvas");
    canvas.className = "gdcard-3d";
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(300, 200, false);
    const cam = new THREE.PerspectiveCamera(32, 1.5, 0.1, 100);
    cam.position.set(1.19, 0.85, 2.25); cam.lookAt(0, -0.05, 0);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    const scene = new THREE.Scene();
    scene.environment = env;
    scene.add(new THREE.AmbientLight("#8a78ff", 0.85));
    const key = new THREE.DirectionalLight("#27e7ff", 1.7); key.position.set(2.2, 3, 2.4); scene.add(key);
    const rim = new THREE.DirectionalLight("#ff39c0", 1.5); rim.position.set(-2.4, 1.2, -2); scene.add(rim);
    const pivot = new THREE.Group(); scene.add(pivot);
    live = { canvas, renderer, scene, cam, pivot, loader: new GLTFLoader() };
    return live;
  };
  const stopLive = () => {
    liveToken++; // invalidate any in-flight load / running loop
    if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
    if (live && liveModel) { live.pivot.remove(liveModel); disposeTree(liveModel); liveModel = null; }
    live?.canvas.classList.remove("on");
  };
  const startLive = (c: CarOption) => {
    const L = ensureLive();
    detailCard.querySelector(".gdcard-win")?.appendChild(L.canvas); // move the shared canvas into this card
    L.pivot.rotation.set(0, HERO_YAW, 0);
    const token = ++liveToken;
    L.loader.load(c.url, (gltf) => {
      const model = gltf.scene;
      if (token !== liveToken) { disposeTree(model); return; } // superseded by a newer open/close
      model.rotation.y = MODEL_YAW + (c.yaw ?? 0);
      const sph = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
      model.scale.setScalar((1 / (sph.radius || 1)) * (c.scale ?? 1));
      const ctr = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
      model.position.set(-ctr.x, -ctr.y, -ctr.z);
      model.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => { if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).envMapIntensity = 0.7; }); });
      L.pivot.add(model); liveModel = model; L.canvas.classList.add("on");
      detailCard.querySelector(".gdcard-art")?.classList.add("hide"); // drop the placeholder PNG so only the live car shows
      let last = 0;
      const loop = (t: number) => {
        if (token !== liveToken) return;
        const dt = last ? Math.min(0.05, (t - last) / 1000) : 0; last = t;
        L.pivot.rotation.y += dt * 0.5;
        L.renderer.render(L.scene, L.cam);
        liveRaf = requestAnimationFrame(loop);
      };
      liveRaf = requestAnimationFrame(loop);
    }, undefined, (err) => { console.warn("[garage] live GLB failed:", c.url, err); });
  };

  const closeDetail = () => {
    stopLive();
    detailScrim.classList.remove("on");
    detailCard.style.transform = "";
    if (detailPoll) { clearInterval(detailPoll); detailPoll = 0; }
  };
  const openDetail = (c: CarOption, i: number, gridEl: HTMLElement) => {
    const rarity = c.rarity ?? 1;
    const t = tierOf(rarity);
    const p = c.power;
    const ab = p
      ? `<span class="gdcard-ab-ic">${icon(p.icon, 18)}</span><span class="gdcard-ab-tx"><span class="gdcard-ab-nm">${p.name}</span><span class="gdcard-ab-ds">${p.desc}</span></span>`
      : `<span class="gdcard-ab-tx"><span class="gdcard-ab-nm" style="color:var(--mut)">Stock</span><span class="gdcard-ab-ds">no special ability — pure drive</span></span>`;
    const holo = rarity >= 4 ? `<div class="gdcard-holo"></div><div class="gdcard-shine"></div>` : "";
    detailCard.innerHTML =
      `<div class="gdcard-face">` +
        `<div class="gdcard-glare"></div>` +
        `<button class="gdcard-x" data-dact="close" aria-label="Back">${backIcon(18)}</button>` +
        `<div class="gdcard-head"><span class="gdcard-name">${c.name}</span><span class="gdcard-rar">${gems(rarity)}</span></div>` +
        `<div class="gdcard-tier" style="color:${t.color}"><span>${t.name}</span></div>` +
        `<div class="gdcard-win">${holo}<img class="gdcard-art" alt="${c.name}"></div>` +
        `<div class="gdcard-ab">${ab}</div>` +
        `<button class="gdcard-equip${busy ? " dis" : ""}" data-dact="equip">${busy ? "ROUND LIVE — CASH OUT TO SWITCH" : "EQUIP"}</button>` +
      `</div>`;
    const dart = detailCard.querySelector(".gdcard-art") as HTMLImageElement;
    const setArt = () => { const src = cards[i].art.src; if (src) { dart.src = src; return true; } return false; };
    if (!setArt()) detailPoll = window.setInterval(() => { if (setArt()) { clearInterval(detailPoll); detailPoll = 0; } }, 160);
    (detailCard.querySelector('[data-dact="equip"]') as HTMLButtonElement).onclick = () => { if (busy) return; select(gridEl, c); closeDetail(); };
    (detailCard.querySelector('[data-dact="close"]') as HTMLButtonElement).onclick = closeDetail;
    startLive(c); // lazy live-3D fades in over the static PNG
    detailScrim.classList.add("on");
  };
  detailScrim.addEventListener("click", (e) => { if (e.target === detailScrim) closeDetail(); });
  detailCard.addEventListener("pointermove", (e) => {
    const r = detailCard.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    detailCard.style.transform = `rotateY(${((px - 0.5) * 12).toFixed(2)}deg) rotateX(${((0.5 - py) * 12).toFixed(2)}deg)`;
    const g = detailCard.querySelector(".gdcard-glare") as HTMLElement | null;
    if (g) { g.style.setProperty("--gx", `${(px * 100).toFixed(1)}%`); g.style.setProperty("--gy", `${(py * 100).toFixed(1)}%`); }
  });
  detailCard.addEventListener("pointerleave", () => { detailCard.style.transform = ""; });

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.setAttribute("aria-label", "Open menu");
  menuButton.className = "panel";
  menuButton.style.cssText = ["width:42px", "height:42px", "padding:0", "display:grid", "place-items:center", "border-radius:9px", "cursor:pointer", "background:rgba(12,10,26,.74)"].join(";");
  menuButton.innerHTML = `<span style="display:flex;flex-direction:column;gap:5px;width:18px">
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
    <span style="height:2px;background:var(--ink);border-radius:2px;box-shadow:0 0 8px rgba(39,231,255,.45)"></span>
  </span>`;

  const setView = (v: View) => {
    view = v;
    menuPanel.style.display = v === "menu" ? "flex" : "none";
    garagePanel.style.display = v === "garage" ? "flex" : "none";
    worldsPanel.style.display = v === "worlds" ? "flex" : "none";
    if (v === "garage") { renderArt(); updateBusyUI(); }
    if (v === "worlds") renderWorlds(); // reflect the active skin + highlight it
    if (v === "menu") refreshMenu(); // reflect current Music/SFX volumes each time the menu shows
  };

  const open = () => {
    overlay.style.display = "flex";
    menuButton.style.display = "none";
    setHudMenuMode(parent, wrap, true);
    applyShowroom(); // reopening via the hamburger in the garage keeps the translucent backdrop
    setView("menu");
  };
  const close = (reason: "dismiss" | "chain" = "dismiss") => {
    overlay.style.display = "none";
    setHudMenuMode(parent, wrap, false);
    menuButton.style.display = "grid"; // the menu button is always available
    // reason "dismiss" (✕/Esc/backdrop) → the lobby/showroom may fully close; "chain" (Upgrades/
    // Logout) opens another panel over the same place, so the showroom must stay standing
    onClose?.(reason);
  };

  onTap(menuButton, open); // any-finger tap (the ☰ opener); every other carpicker onclick is an overlay control, left as-is
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || overlay.style.display === "none") return;
    if (detailScrim.classList.contains("on")) { closeDetail(); return; }
    if (view === "menu") close(); else setView("menu");
  });
  overlay.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-act],[data-go],[data-toggle],[data-world]") as HTMLElement | null;
    if (!t) return;
    if (t.dataset.world !== undefined) { if (t.classList.contains("locked")) return; worlds?.set(t.dataset.world); renderWorlds(); return; } // switch level skin (sealed skins ignore the tap), stay open
    if (t.dataset.act === "history") { close("chain"); menuButton.focus(); menuFeatures.onHistory?.(); return; }
    if (t.dataset.act === "close") close();
    else if (t.dataset.act === "back") setView("menu");
    else if (t.dataset.act === "upgrades") { close("chain"); onUpgrades?.(); }
    else if (t.dataset.act === "logout") { close("chain"); onLogout?.(); }
    else if (t.dataset.act === "howto") { close(); parent.dispatchEvent(new CustomEvent("raider:howto")); }
    else if (t.dataset.go) setView(t.dataset.go as View);
  });

  overlay.appendChild(menuPanel);
  overlay.appendChild(garagePanel);
  overlay.appendChild(worldsPanel);
  overlay.appendChild(detailScrim);
  wrap.appendChild(menuButton);
  wrap.appendChild(overlay);
  parent.appendChild(wrap);

  return {
    el: wrap,
    setBusy(b: boolean) { busy = b; updateBusyUI(); },
    openGarage() { wrap.style.display = "block"; open(); setView("garage"); },
    grant(name: string) {
      const idx = cars.findIndex((c) => c.name === name);
      if (idx < 0 || !cars[idx].locked) return; // unknown car or already owned
      cars[idx].locked = false;
      cards[idx] = fillCard(grid.children[idx] as HTMLElement, cars[idx], idx);
      rendered = false; renderArt(); // re-render owned card art (the newly-unlocked one now included)
    },
    isOpen: () => overlay.style.display !== "none",
    // on: the hamburger takes the price chip's top-row slot; off: the below-graph row (base+134 = 144 on desktop)
    setMenuTop(on: boolean) { wrap.style.top = on ? "max(10px,env(safe-area-inset-top))" : "calc(max(10px,env(safe-area-inset-top)) + 134px)"; },
    setShowroom(on: boolean) { showroom = on; applyShowroom(); },
  };
}
