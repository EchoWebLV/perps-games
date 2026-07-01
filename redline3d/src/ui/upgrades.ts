import { CONFIG } from "../core/config";
import { addCoins as addCoinsRaw } from "../core/coins";

export type Track = "tank" | "turbo" | "suspension";
export const MAX_LEVEL = 10;

/** coins to go from `level` → `level+1` (escalating) */
export function upgradeCost(level: number): number {
  return 20 * (level + 1);
}
/** a track's effective value at a given level */
export function trackValue(base: number, step: number, level: number): number {
  return base + step * level;
}

interface TrackDef {
  key: Track; name: string; sub: string; icon: string;
  field: "MAXSEC" | "RMAX" | "LIQ"; step: number;
  fmt: (v: number) => string;
  /** wired end-to-end (the on-chain program honors it). Non-live tracks are hidden until the
   *  program supports them per-round — showing them would spend coins for no real effect. */
  live: boolean;
}

const ICONS: Record<string, string> = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.4 2"/>',
  gauge: '<path d="M4.5 18a7.5 7.5 0 1 1 15 0"/><path d="M12 14l4.2-3.2"/><circle cx="12" cy="14" r="1.3" fill="currentColor"/>',
  shield: '<path d="M12 3l7 2.5v5.5c0 4.2-3 7-7 8-4-1-7-3.8-7-8V5.5L12 3z"/>',
  level: '<path d="M6 13l6-6 6 6"/><path d="M6 18l6-6 6 6"/>',
};
const svg = (id: string, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ""}</svg>`;

const TRACKS: TrackDef[] = [
  { key: "turbo", name: "Turbo Kit", sub: "max leverage", icon: "gauge", field: "RMAX", step: 50, fmt: (v) => `${Math.round(v)}×`, live: true },
  { key: "tank", name: "Long-Range Tank", sub: "round time", icon: "clock", field: "MAXSEC", step: 6, fmt: (v) => `${Math.round(v)}s`, live: true },
  { key: "suspension", name: "Suspension", sub: "liquidation floor", icon: "shield", field: "LIQ", step: -0.01, fmt: (v) => `${Math.round(v * 100)}%`, live: true },
];
// Only the tracks the on-chain program actually honors are shown + applied.
const ACTIVE = TRACKS.filter((t) => t.live);

const STORE_KEY = "redline.garage.v1";
type Saved = { coins: number; levels: Record<Track, number> };
function loadSaved(): Saved {
  const fresh: Saved = { coins: 0, levels: { tank: 0, turbo: 0, suspension: 0 } };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fresh;
    const p = JSON.parse(raw);
    return {
      coins: Number.isFinite(p.coins) ? Math.max(0, Math.floor(p.coins)) : 0,
      levels: {
        tank: clampLevel(p.levels?.tank), turbo: clampLevel(p.levels?.turbo), suspension: clampLevel(p.levels?.suspension),
      },
    };
  } catch { return fresh; }
}
const clampLevel = (n: unknown) => Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(n) || 0)));

export interface Upgrades {
  coins(): number;
  /** credit collected coins (persists + notifies) */
  addCoins(n: number): void;
  open(): void;
  /** hide the button + close the panel during a live round */
  setBusy(busy: boolean): void;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .upg-panel{width:min(384px,94vw);padding:16px;display:flex;flex-direction:column;gap:12px;
      background:rgba(12,10,26,.9);border-color:rgba(132,150,224,.28);pointer-events:auto}
    .upg-head{display:flex;align-items:center;gap:10px}
    .upg-head .lbl{flex:1}
    .upg-coins{display:flex;align-items:center;gap:5px;font:700 14px/1 'Chakra Petch',ui-monospace,monospace;color:var(--amb);
      text-shadow:0 0 9px rgba(255,209,102,.5)}
    .upg-x{cursor:pointer;color:var(--mut);font:700 16px/1 Chakra Petch,ui-monospace,monospace;padding:3px 5px;border:0;background:transparent}
    .upg-row{display:flex;flex-direction:column;gap:8px;padding:13px;border-radius:12px;
      background:rgba(18,14,40,.72);border:1px solid rgba(132,150,224,.24)}
    .upg-top{display:flex;align-items:center;gap:11px}
    .upg-ic{display:flex;color:var(--cyan);filter:drop-shadow(0 0 6px rgba(39,231,255,.5))}
    .upg-tx{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
    .upg-tx b{font:700 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.04em}
    .upg-tx small{font:500 10px/1.2 'Chakra Petch',ui-monospace,monospace;color:var(--mut)}
    .upg-val{font:800 17px/1 'Chakra Petch',ui-monospace,monospace;color:#fff;text-shadow:0 0 8px rgba(39,231,255,.4)}
    .upg-bar{display:flex;gap:3px}
    .upg-pip{flex:1;height:6px;border-radius:2px;background:rgba(255,255,255,.12)}
    .upg-pip.on{background:var(--cyan);box-shadow:0 0 6px rgba(39,231,255,.7)}
    .upg-foot{display:flex;align-items:center;gap:10px}
    .upg-next{flex:1;font:600 11px/1.2 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.7)}
    .upg-next b{color:var(--cyan)}
    .upg-buy{border:0;border-radius:9px;padding:9px 14px;cursor:pointer;font:800 12px/1 'Chakra Petch',ui-monospace,monospace;
      letter-spacing:.08em;text-transform:uppercase;color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);
      box-shadow:0 4px 12px rgba(46,230,166,.32)}
    .upg-buy:disabled{cursor:not-allowed;color:var(--mut);background:rgba(255,255,255,.08);box-shadow:none}
    .upg-buy.max{color:var(--amb);background:rgba(255,209,102,.14)}
  `;
  document.head.appendChild(s);
}

export function createUpgrades(
  parent: HTMLElement,
  opts: { onCoins?: (n: number) => void; onApply?: () => void; economicEffects?: boolean; onClose?: () => void } = {},
): Upgrades {
  injectStyles();
  const saved = loadSaved();
  // capture base config values BEFORE applying any upgrade
  const base = { MAXSEC: CONFIG.MAXSEC, RMAX: CONFIG.RMAX, LIQ: CONFIG.LIQ };

  const apply = () => {
    if (opts.economicEffects) {
      for (const t of ACTIVE) CONFIG[t.field] = trackValue(base[t.field], t.step, saved.levels[t.key]);
    }
    opts.onApply?.(); // gauge rescales/redraws to the new RMAX
  };
  const persist = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* ignore */ } };
  apply();

  // ---- overlay + panel (opened from the garage menu's "Upgrades" item) ----
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:9", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(22px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))",
    "background:rgba(0,0,0,.8)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");
  const panel = document.createElement("div");
  panel.className = "panel upg-panel";
  const coinChip = `<span class="upg-coins">◈ <span id="upgCoins">0</span></span>`;
  panel.innerHTML =
    `<div class="upg-head"><span class="lbl">upgrades</span>${coinChip}<button class="upg-x" aria-label="Close">✕</button></div>` +
    ACTIVE.map((t) => `
      <div class="upg-row" data-row="${t.key}">
        <div class="upg-top">
          <span class="upg-ic">${svg(t.icon)}</span>
          <span class="upg-tx"><b>${t.name}</b><small>${t.sub}</small></span>
          <span class="upg-val" data-val="${t.key}">–</span>
        </div>
        <div class="upg-bar" data-bar="${t.key}">${Array.from({ length: MAX_LEVEL }, () => `<span class="upg-pip"></span>`).join("")}</div>
        <div class="upg-foot"><span class="upg-next" data-next="${t.key}"></span><button class="upg-buy" data-buy="${t.key}">Buy</button></div>
      </div>`).join("");

  const coinsEl = panel.querySelector("#upgCoins") as HTMLElement;

  const render = () => {
    coinsEl.textContent = String(saved.coins);
    for (const t of ACTIVE) {
      const lvl = saved.levels[t.key];
      const val = trackValue(base[t.field], t.step, lvl);
      (panel.querySelector(`[data-val="${t.key}"]`) as HTMLElement).textContent = t.fmt(val);
      const pips = panel.querySelectorAll(`[data-bar="${t.key}"] .upg-pip`);
      pips.forEach((p, i) => p.classList.toggle("on", i < lvl));
      const nextEl = panel.querySelector(`[data-next="${t.key}"]`) as HTMLElement;
      const buy = panel.querySelector(`[data-buy="${t.key}"]`) as HTMLButtonElement;
      if (lvl >= MAX_LEVEL) {
        nextEl.innerHTML = `<b>MAX</b> · Lv ${MAX_LEVEL}/${MAX_LEVEL}`;
        buy.textContent = "MAX"; buy.disabled = true; buy.classList.add("max");
      } else {
        const cost = upgradeCost(lvl);
        const nextVal = trackValue(base[t.field], t.step, lvl + 1);
        nextEl.innerHTML = `Lv ${lvl}/${MAX_LEVEL} → <b>${t.fmt(nextVal)}</b> · ${cost} ◈`;
        buy.textContent = `${cost} ◈`; buy.classList.remove("max");
        buy.disabled = saved.coins < cost;
      }
    }
  };

  const buy = (key: Track) => {
    const lvl = saved.levels[key];
    if (lvl >= MAX_LEVEL) return;
    const cost = upgradeCost(lvl);
    if (saved.coins < cost) return;
    saved.coins -= cost;
    saved.levels[key] = lvl + 1;
    apply(); persist(); render();
    opts.onCoins?.(saved.coins);
  };
  panel.querySelectorAll("[data-buy]").forEach((b) =>
    b.addEventListener("click", () => buy((b as HTMLElement).dataset.buy as Track)));

  const setOpen = (open: boolean) => {
    overlay.style.display = open ? "flex" : "none";
    if (open) render();
    else opts.onClose?.();
  };
  (panel.querySelector(".upg-x") as HTMLElement).onclick = () => setOpen(false);
  overlay.onclick = (e) => { if (e.target === overlay) setOpen(false); };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false); });

  overlay.appendChild(panel);
  parent.appendChild(overlay);

  return {
    coins: () => saved.coins,
    addCoins(n) { saved.coins = addCoinsRaw(saved.coins, n); persist(); opts.onCoins?.(saved.coins); },
    open: () => setOpen(true),
    setBusy(b) { if (b) setOpen(false); }, // reachable only via the garage menu, which is itself gated
  };
}
