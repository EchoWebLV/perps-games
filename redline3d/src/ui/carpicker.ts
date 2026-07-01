import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** a car's special ability id; drives in-game effects when that card is selected */
export type CarAbility = "laneBet" | "nitro" | "rainbow";
/** card-face display of the car's power (the ability shown on the card) */
export interface CarPower { name: string; desc: string; icon: string }
export interface CarOption {
  name: string; url: string; scale?: number; yaw?: number;
  ability?: CarAbility; power?: CarPower;
  baseLev?: number;         // car's base max leverage (raises the dial ceiling, e.g. Cybertruck 1500)
  rarity?: 1 | 2 | 3;       // collectible tier (gems on the card)
  locked?: boolean;         // not yet owned → shown sealed in the collection
}
export interface Garage {
  /** the wrap element (hamburger button + overlay) — lets the lobby toggle its chrome */
  el: HTMLElement;
  /** while a round is live: the menu stays open, but cars can't be switched */
  setBusy(busy: boolean): void;
  /** open the overlay straight to the garage (car collection) view — used by the lobby Garage building */
  openGarage(): void;
}

const MODEL_YAW = Math.PI;       // base facing (matches the in-game car)
const HERO_YAW = -0.6;           // 3/4 pose for the captured card art

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
};
const icon = (id: string, size = 15) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ""}</svg>`;
const backIcon = (size: number) => icon("chevron", size).replace('d="M9 6l6 6-6 6"', 'd="M15 6l-6 6 6 6"');
const gems = (n: number) => Array.from({ length: 3 }, (_, k) => `<span class="gem${k < n ? " on" : ""}"></span>`).join("");

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
    .gpanel{width:min(384px,94vw);padding:15px;display:flex;flex-direction:column;gap:13px;
      background:rgba(12,10,26,.9);border-color:rgba(132,150,224,.28);pointer-events:auto}
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
    .ghelp{font:500 12px/1.7 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.8)}
    .ghelp b{color:var(--cyan)}
    .gbusy{display:flex;align-items:center;gap:7px;margin:0 6px;padding:7px 10px;border-radius:8px;
      background:rgba(255,77,109,.12);border:1px solid rgba(255,77,109,.42);color:#ff9aa6;
      font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
    .ggrid.locked .gcard:not(.locked){cursor:not-allowed}
    .ggrid.locked .gcard:not(.locked):hover{transform:none;box-shadow:0 9px 22px rgba(0,0,0,.55)}
    .ggrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;overflow-y:auto;overflow-x:hidden;
      max-height:min(72vh,560px);padding:8px 6px 10px;-webkit-overflow-scrolling:touch}
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
  `;
  document.head.appendChild(s);
}

/** Game menu → Garage. Cars are rendered ONCE to static card art (light, no live canvas). */
/** A bottom-of-menu on/off row (Music, SFX, …). State is owned by the caller via get/set. */
export interface MenuToggle {
  label: string;
  sub?: string;
  glyph?: string;
  get: () => boolean;
  set: (on: boolean) => void;
}

export function createCarPicker(parent: HTMLElement, cars: CarOption[], onPick: (c: CarOption) => void, onUpgrades?: () => void, toggles: MenuToggle[] = [], onLogout?: () => void, onClose?: () => void): Garage {
  injectStyles();

  const wrap = document.createElement("div");
  wrap.className = "pe";
  wrap.style.cssText = "position:absolute;top:144px;right:max(12px,env(safe-area-inset-right));z-index:8;display:block";

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:9", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");

  type View = "menu" | "garage" | "help";
  let view: View = "menu";

  const menuPanel = document.createElement("div");
  menuPanel.className = "panel gpanel";
  menuPanel.innerHTML =
    `<div class="ghead"><span class="lbl">menu</span><button class="gicon-btn" data-act="close" aria-label="Close">✕</button></div>` +
    `<div class="gmenu">
      <button class="gmenu-item" data-go="garage"><span class="gmenu-ic">${icon("car", 20)}</span><span class="gmenu-tx"><b>Garage</b><small>your card collection</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
      <button class="gmenu-item" data-act="upgrades"><span class="gmenu-ic">${icon("level", 20)}</span><span class="gmenu-tx"><b>Upgrades</b><small>tune your car</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
      <button class="gmenu-item" data-go="help"><span class="gmenu-ic">${icon("help", 20)}</span><span class="gmenu-tx"><b>How to play</b><small>controls &amp; the bet</small></span><span class="gmenu-arr">${icon("chevron", 16)}</span></button>
    </div>`;

  // audio on/off toggles (Music / SFX) appended at the bottom of the menu list
  const gmenu = menuPanel.querySelector(".gmenu") as HTMLElement | null;
  if (toggles.length && gmenu) {
    const sep = document.createElement("div");
    sep.textContent = "audio";
    sep.style.cssText = "margin:8px 4px 2px;font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;color:var(--mut)";
    gmenu.appendChild(sep);
    toggles.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "gmenu-item";
      b.dataset.toggle = String(i);
      b.innerHTML =
        `<span class="gmenu-ic" style="font:700 18px/1 'Chakra Petch',ui-monospace,monospace">${t.glyph ?? "♪"}</span>` +
        `<span class="gmenu-tx"><b>${t.label}</b>${t.sub ? `<small>${t.sub}</small>` : ""}</span>` +
        `<span class="gmenu-sw" style="margin-left:auto;min-width:48px;text-align:center;padding:5px 9px;border-radius:999px;font:700 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em"></span>`;
      gmenu.appendChild(b);
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
      `<span class="gmenu-tx"><b>Log out</b><small>sign out of your account</small></span>` +
      `<span class="gmenu-arr">${icon("chevron", 16)}</span>`;
    gmenu.appendChild(b);
  }

  const renderToggles = () => {
    toggles.forEach((t, i) => {
      const sw = menuPanel.querySelector(`[data-toggle="${i}"] .gmenu-sw`) as HTMLElement | null;
      if (!sw) return;
      const on = t.get();
      sw.textContent = on ? "ON" : "OFF";
      sw.style.background = on ? "rgba(39,231,255,.16)" : "rgba(255,255,255,.05)";
      sw.style.color = on ? "var(--cyan)" : "var(--mut)";
      sw.style.boxShadow = on ? "inset 0 0 10px rgba(39,231,255,.35)" : "none";
    });
  };

  const helpPanel = document.createElement("div");
  helpPanel.className = "panel gpanel";
  helpPanel.style.display = "none";
  helpPanel.innerHTML =
    `<div class="ghead"><button class="gicon-btn" data-act="back" aria-label="Back">${backIcon(18)}</button><span class="lbl">how to play</span><button class="gicon-btn" data-act="close" aria-label="Close">✕</button></div>` +
    `<div class="ghelp"><b>Hold the road</b> to drive · <b>drag</b> to steer · <b>pull back</b> to brake.<br>Tap <b>GO</b> to open your bet — <b>rev</b> for leverage, <b>cash out</b> before you liquidate.<br>Pick a car in the <b>Garage</b>; each has its own power.</div>`;

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
    if (c.locked) return;
    if (busy) { busyNote.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 240 }); return; }
    if (selectedEl) selectedEl.classList.remove("sel");
    el.classList.add("sel");
    selectedEl = el;
    onPick(c);
  };

  cars.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "gcard" + (c.locked ? " locked" : "");
    const series = `${String(i + 1).padStart(2, "0")} / ${String(cars.length).padStart(2, "0")}`;
    const rarity = c.rarity ?? (c.ability ? 3 : 2);
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
    }
    const art = card.querySelector(".gcard-art") as HTMLImageElement;
    const spinner = card.querySelector(".gcard-ld") as HTMLElement;
    card.onclick = () => select(card, c);
    grid.appendChild(card);
    cards.push({ art, spinner, locked: !!c.locked });
  });
  const firstOpen = cars.findIndex((c) => !c.locked);
  if (firstOpen >= 0) { (grid.children[firstOpen] as HTMLElement).classList.add("sel"); selectedEl = grid.children[firstOpen] as HTMLElement; }

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
    let pending = 0;
    cars.forEach((c, i) => {
      if (c.locked) return;
      pending++;
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
        if (--pending === 0) { env.dispose(); r.dispose(); } // last one in → tear the renderer down
      }, undefined, (err) => { console.warn("[garage] GLB failed:", c.url, err); pending--; });
    });
  };

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
    helpPanel.style.display = v === "help" ? "flex" : "none";
    if (v === "garage") { renderArt(); updateBusyUI(); }
    if (v === "menu") renderToggles(); // reflect current Music/SFX state each time the menu shows
  };

  const open = () => {
    overlay.style.display = "flex";
    menuButton.style.display = "none";
    setHudMenuMode(parent, wrap, true);
    setView("menu");
  };
  const close = () => {
    overlay.style.display = "none";
    setHudMenuMode(parent, wrap, false);
    menuButton.style.display = "grid"; // the menu button is always available
    onClose?.(); // let the lobby re-assert its chrome (hide the hamburger again, restore the back button)
  };

  menuButton.onclick = open;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || overlay.style.display === "none") return;
    if (view === "menu") close(); else setView("menu");
  });
  overlay.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-act],[data-go],[data-toggle]") as HTMLElement | null;
    if (!t) return;
    if (t.dataset.toggle !== undefined) { const i = +t.dataset.toggle; toggles[i].set(!toggles[i].get()); renderToggles(); return; }
    if (t.dataset.act === "close") close();
    else if (t.dataset.act === "back") setView("menu");
    else if (t.dataset.act === "upgrades") { close(); onUpgrades?.(); }
    else if (t.dataset.act === "logout") { close(); onLogout?.(); }
    else if (t.dataset.go) setView(t.dataset.go as View);
  });

  overlay.appendChild(menuPanel);
  overlay.appendChild(garagePanel);
  overlay.appendChild(helpPanel);
  wrap.appendChild(menuButton);
  wrap.appendChild(overlay);
  parent.appendChild(wrap);

  return {
    el: wrap,
    setBusy(b: boolean) { busy = b; updateBusyUI(); },
    openGarage() { wrap.style.display = "block"; open(); setView("garage"); },
  };
}
