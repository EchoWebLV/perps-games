// The Slopwheels boot surface: your collection is the game's front door.
// Pure DOM (no three.js import) — home must cost nothing on the GPU.
import type { CarOption } from "./carpicker";
import { carDisplayName } from "./carpicker";
import { tierOf } from "../core/rarity";
import { onTap } from "./tap";

export interface HomeDeps {
  cars: () => CarOption[];              // CAR_DEFS
  owns: (name: string) => boolean;      // inventory.owns
  equippedName: () => string;           // current equipped car
  onDriveLobby: (carName: string) => void;
  onEnterRace: (carName: string) => void;
  onWatchAndBet: () => void;
  onOpenStore: () => void;              // crateBox.open()
}
export interface Home {
  el: HTMLElement;
  show(): void;                          // (re)renders the grid from current ownership
  hide(): void;
  isOpen(): boolean;
  /** minimal transient toast in home's visual style (the "coming soon" stubs use it) */
  toast(msg: string): void;
  dispose(): void;
}

/** Slug a card's DISPLAY name exactly like scripts/bake-cards.mjs (~L87), so the baked
 *  `/cards/<slug>.png` filename lines up with what home requests. Copy of that regex chain. */
export const cardSlug = (displayName: string): string =>
  displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function sortForCollection(defs: CarOption[], owns: (n: string) => boolean): CarOption[] {
  return [...defs].sort((a, b) => {
    const ao = owns(a.name) ? 1 : 0, bo = owns(b.name) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    if ((a.rarity ?? 0) !== (b.rarity ?? 0)) return (b.rarity ?? 0) - (a.rarity ?? 0);
    return a.name.localeCompare(b.name);
  });
}

// lock glyph (stroked, inherits currentColor) — no emoji, matches the carpicker/cratebox line-icon look
const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
// generic car silhouette shown in the art window when the baked PNG is missing/broken
const CAR_SVG =
  '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l1.6-4.2A2.5 2.5 0 0 1 8 7h8a2.5 2.5 0 0 1 2.4 1.8L20 13v5h-2.4v-1.6h-11.2V18H4z"/><circle cx="7.6" cy="14.8" r="1.4"/><circle cx="16.4" cy="14.8" r="1.4"/></svg>';

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .sw-home{position:fixed;inset:0;z-index:30;display:none;flex-direction:column;pointer-events:auto;
      background:radial-gradient(120% 90% at 50% -8%,rgba(39,231,255,.10),transparent 52%),
        radial-gradient(120% 90% at 50% 108%,rgba(255,57,192,.10),transparent 55%),#05030d;
      color:var(--ink,#e6ecf7);font-family:'Chakra Petch',ui-monospace,monospace;
      padding:max(14px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left))}
    .sw-home.on{display:flex}
    .sw-head{display:flex;align-items:center;justify-content:center;padding:6px 0 12px;flex:none}
    .sw-wordmark{height:48px;width:auto;max-width:80vw;object-fit:contain;filter:drop-shadow(0 0 14px rgba(39,231,255,.35))}
    .sw-tabs{display:flex;gap:8px;justify-content:center;padding:0 0 12px;flex:none}
    .sw-tab{border:1px solid rgba(132,150,224,.28);background:rgba(18,14,40,.72);color:var(--mut,#9aa4b2);
      padding:9px 20px;border-radius:11px;cursor:pointer;font:700 12px/1 'Chakra Petch',ui-monospace,monospace;
      letter-spacing:.1em;text-transform:uppercase;transition:border-color .15s,background .15s,color .15s}
    .sw-tab.on{border-color:var(--cyan,#27e7ff);color:#fff;background:rgba(30,24,62,.85);box-shadow:0 0 14px rgba(39,231,255,.28)}
    .sw-tab:not(.on):hover{color:var(--ink,#e6ecf7);border-color:rgba(132,150,224,.5)}
    .sw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:12px;
      overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;flex:1;
      padding:4px 4px 16px;scrollbar-width:thin;scrollbar-color:rgba(132,150,224,.45) transparent}
    .sw-grid::-webkit-scrollbar{width:8px}
    .sw-grid::-webkit-scrollbar-thumb{background:rgba(132,150,224,.45);border-radius:8px}
    .sw-card{position:relative;display:flex;flex-direction:column;gap:7px;padding:8px;border-radius:13px;
      border:1.5px solid rgba(132,150,224,.24);background:linear-gradient(168deg,rgba(30,22,74,.9),rgba(14,10,30,.94));
      box-shadow:0 8px 20px rgba(0,0,0,.5)}
    .sw-card.equipped{border-color:var(--cyan,#27e7ff);box-shadow:0 0 0 1px var(--cyan,#27e7ff),0 10px 26px rgba(39,231,255,.4)}
    .sw-card.locked{filter:grayscale(.55) brightness(.72)}
    .sw-win{position:relative;height:104px;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.14);
      background:radial-gradient(120% 80% at 50% 98%,rgba(39,231,255,.16),rgba(255,57,192,.05) 54%,transparent 78%),linear-gradient(180deg,#231947,#0b0816 74%)}
    .sw-silh{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
      color:rgba(154,164,178,.6);text-align:center;padding:6px}
    .sw-silh span{font:700 9px/1.2 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;color:rgba(216,222,255,.5);
      white-space:normal;max-width:100%;overflow:hidden}
    .sw-art{position:absolute;inset:3px;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:contain;opacity:0;transition:opacity .3s ease}
    .sw-art.on{opacity:1}
    .sw-lock{position:absolute;inset:0;display:grid;place-items:center;color:rgba(220,225,255,.85);pointer-events:none}
    .sw-title{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 2px}
    .sw-name{font:700 12px/1.1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:#fff;text-transform:uppercase;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 8px rgba(39,231,255,.4)}
    .sw-card.locked .sw-name{color:var(--mut,#9aa4b2);text-shadow:none}
    .sw-pips{display:flex;gap:3px;flex:none}
    .sw-pip{width:6px;height:6px;transform:rotate(45deg);border-radius:1px}
    .sw-acts{display:flex;flex-direction:column;gap:6px}
    .sw-row{display:flex;gap:6px}
    .sw-btn{flex:1;border:0;border-radius:9px;padding:9px 6px;cursor:pointer;white-space:nowrap;
      font:800 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase}
    .sw-btn.race{color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 3px 10px rgba(46,230,166,.3)}
    .sw-btn.drive{color:#04222b;background:linear-gradient(180deg,#5cf0ff,#12c7e6);box-shadow:0 3px 10px rgba(39,231,255,.3)}
    .sw-btn.crates{color:var(--amb,#ffd166);background:rgba(255,209,102,.12);border:1px solid rgba(255,209,102,.42)}
    .sw-btn:hover{filter:brightness(1.08)}
    .sw-foot{flex:none;padding:10px 0 max(12px,env(safe-area-inset-bottom));border-top:1px solid rgba(132,150,224,.18);
      background:linear-gradient(0deg,#05030d,rgba(5,3,13,.2))}
    .sw-watch{width:100%;border:0;border-radius:12px;padding:15px;cursor:pointer;
      font:800 14px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#fff;
      background:linear-gradient(120deg,#7d1f6a,#3c1d6b 46%,#241a63);border:1px solid rgba(132,150,224,.4);
      box-shadow:0 6px 20px rgba(125,31,106,.4),inset 0 1px 0 rgba(255,255,255,.12)}
    .sw-watch:hover{filter:brightness(1.1)}
    .sw-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:31;
      padding:12px 22px;border-radius:12px;font:700 15px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;
      background:rgba(11,8,32,.94);border:1px solid var(--amb,#ffd166);color:var(--amb,#ffd166);
      text-shadow:0 0 10px rgba(255,209,102,.45);opacity:0;pointer-events:none;transition:opacity .2s ease}
  `;
  document.head.appendChild(s);
}

export function createHome(parent: HTMLElement, deps: HomeDeps): Home {
  injectStyles();

  const el = document.createElement("div");
  el.className = "sw-home";
  el.dataset.home = "1";

  // ── header: the Slopwheels wordmark ──
  const head = document.createElement("div");
  head.className = "sw-head";
  const wordmark = document.createElement("img");
  wordmark.className = "sw-wordmark";
  wordmark.src = "/assets/brands/slopwheels.png";
  wordmark.alt = "Slopwheels";
  head.appendChild(wordmark);
  el.appendChild(head);

  // ── tab strip: [Collection] [Store]. Store fires onOpenStore (its own overlay); Collection is
  //    the only rendered content, so the Store tab never swaps the grid out from under it. ──
  const tabs = document.createElement("div");
  tabs.className = "sw-tabs";
  const collectionTab = document.createElement("button");
  collectionTab.className = "sw-tab on";
  collectionTab.textContent = "Collection";
  const storeTab = document.createElement("button");
  storeTab.className = "sw-tab";
  storeTab.textContent = "Store";
  tabs.append(collectionTab, storeTab);
  el.appendChild(tabs);

  // ── collection grid ──
  const grid = document.createElement("div");
  grid.className = "sw-grid";
  el.appendChild(grid);

  // ── sticky footer: Watch & bet ──
  const foot = document.createElement("div");
  foot.className = "sw-foot";
  const watchBtn = document.createElement("button");
  watchBtn.className = "sw-watch";
  watchBtn.textContent = "Watch & bet";
  foot.appendChild(watchBtn);
  el.appendChild(foot);

  const toastEl = document.createElement("div");
  toastEl.className = "sw-toast";
  el.appendChild(toastEl);

  parent.appendChild(el);

  // Opening the store hides home (the crate overlay sits BELOW home's z-index); crateBox.onClose
  // brings home back via show(), which also picks up any car just pulled from the crate.
  const openStore = () => { hide(); deps.onOpenStore(); };

  onTap(collectionTab, () => { collectionTab.classList.add("on"); storeTab.classList.remove("on"); });
  onTap(storeTab, openStore);
  onTap(watchBtn, () => deps.onWatchAndBet());

  const addPips = (host: HTMLElement, rarity: number) => {
    for (let i = 0; i < rarity; i++) {
      const pip = document.createElement("span");
      pip.className = "sw-pip";
      const c = tierOf(rarity).color;
      pip.style.background = c;
      pip.style.boxShadow = `0 0 5px ${c}cc`;
      host.appendChild(pip);
    }
  };

  const buildCard = (c: CarOption): HTMLElement => {
    const owned = deps.owns(c.name);
    const display = carDisplayName(c);
    const card = document.createElement("div");
    card.className = "sw-card" + (owned ? " owned" : " locked") +
      (c.name === deps.equippedName() ? " equipped" : "");

    // art window: baked PNG on top of a silhouette fallback (name text + car glyph)
    const win = document.createElement("div");
    win.className = "sw-win";
    const silh = document.createElement("div");
    silh.className = "sw-silh";
    silh.innerHTML = CAR_SVG; // static glyph, no dynamic data
    const silhName = document.createElement("span");
    silhName.textContent = display; // textContent — never inject a name as HTML
    silh.appendChild(silhName);
    win.appendChild(silh);
    const art = document.createElement("img");
    art.className = "sw-art";
    art.alt = display;
    art.src = `/cards/${cardSlug(display)}.png`;
    art.addEventListener("load", () => art.classList.add("on"));
    art.addEventListener("error", () => { art.remove(); }); // drop broken art → silhouette shows
    win.appendChild(art);
    if (!owned) {
      const lock = document.createElement("div");
      lock.className = "sw-lock";
      lock.innerHTML = LOCK_SVG;
      win.appendChild(lock);
    }
    card.appendChild(win);

    // title row: name + rarity pips
    const title = document.createElement("div");
    title.className = "sw-title";
    const name = document.createElement("span");
    name.className = "sw-name";
    name.textContent = display;
    const pips = document.createElement("span");
    pips.className = "sw-pips";
    addPips(pips, c.rarity ?? 0);
    title.append(name, pips);
    card.appendChild(title);

    // actions: owned → race / drive ; unowned → get crates
    const acts = document.createElement("div");
    acts.className = "sw-acts";
    if (owned) {
      const row = document.createElement("div");
      row.className = "sw-row";
      const race = document.createElement("button");
      race.className = "sw-btn race";
      race.textContent = "Enter race";
      onTap(race, () => deps.onEnterRace(c.name));
      const drive = document.createElement("button");
      drive.className = "sw-btn drive";
      drive.textContent = "Drive lobby";
      onTap(drive, () => deps.onDriveLobby(c.name));
      row.append(race, drive);
      acts.appendChild(row);
    } else {
      const get = document.createElement("button");
      get.className = "sw-btn crates";
      get.textContent = "Get crates";
      onTap(get, openStore);
      acts.appendChild(get);
    }
    card.appendChild(acts);
    return card;
  };

  const render = () => {
    grid.replaceChildren(); // fresh build → old card elements + their listeners are discarded
    for (const c of sortForCollection(deps.cars(), deps.owns)) grid.appendChild(buildCard(c));
  };

  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function show() {
    render();
    // returning from the store lands back on Collection (the only content tab)
    collectionTab.classList.add("on"); storeTab.classList.remove("on");
    el.classList.add("on");
  }
  function hide() { el.classList.remove("on"); }

  return {
    el,
    show,
    hide,
    isOpen: () => el.classList.contains("on"),
    toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 1600);
    },
    dispose() {
      if (toastTimer) clearTimeout(toastTimer);
      el.remove(); // card/button listeners live on removed descendants → GC'd with the tree
    },
  };
}
