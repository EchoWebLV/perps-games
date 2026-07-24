// The Slopwheels boot surface: your collection is the game's front door.
// Pure DOM (no three.js render) — home must cost nothing on the GPU. Clash-Royale/Hearthstone
// collection idiom in the Slopwheels skin: near-black bg, acid-green accents, chunky comic borders,
// cars arranged BY STARS (rarity tiers, 5★ first), unowned cars shown as gacha SILHOUETTES.
import type { CarOption } from "./carpicker";
import { carDisplayName, icon } from "./carpicker";
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

export interface TierGroup { rarity: number; cars: CarOption[]; }
/** Arrange the roster BY STARS: one section per rarity tier that has cars, highest rarity (5★) first.
 *  Within a tier the owned cars lead, then the rest by name. Never mutates the caller's array. */
export function groupByTier(defs: CarOption[], owns: (n: string) => boolean): TierGroup[] {
  const byRarity = new Map<number, CarOption[]>();
  for (const c of defs) {
    const r = tierOf(c.rarity).id; // clamp to a real tier (missing/oob rarity → Common)
    (byRarity.get(r) ?? byRarity.set(r, []).get(r)!).push(c);
  }
  const groups: TierGroup[] = [];
  for (let r = 5; r >= 1; r--) {
    const cars = byRarity.get(r);
    if (!cars?.length) continue;
    cars.sort((a, b) => {
      const ao = owns(a.name) ? 1 : 0, bo = owns(b.name) ? 1 : 0;
      if (ao !== bo) return bo - ao;            // owned first
      return a.name.localeCompare(b.name);       // then by name
    });
    groups.push({ rarity: r, cars });
  }
  return groups;
}

// lock glyph (stroked, inherits currentColor) — no emoji, matches the carpicker/cratebox line-icon look
const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    /* z-index 30 sits below the access wall (40) and splash (50). The identity gate ALSO uses 30,
       so it wins over home purely by DOM append order (main.ts creates the gate after home) — keep
       that ordering if either is reworked, or bump one of the two to an explicit different layer. */
    .sw-home{--acid:#c1f832;--ink:#e8edf3;--mut:#79838f;--edge:#05070b;
      position:fixed;inset:0;z-index:30;display:none;flex-direction:column;pointer-events:auto;
      background:radial-gradient(130% 80% at 50% -10%,rgba(193,248,50,.08),transparent 55%),#0a0c10;
      color:var(--ink);font-family:'Chakra Petch',ui-monospace,monospace;
      padding:max(14px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left))}
    .sw-home.on{display:flex}
    /* header: the transparent-alpha Slopwheels wordmark — NO plate behind it */
    .sw-head{display:flex;align-items:center;justify-content:center;padding:4px 0 12px;flex:none}
    .sw-wordmark{height:48px;width:auto;max-width:78vw;object-fit:contain;filter:drop-shadow(0 3px 10px rgba(0,0,0,.6))}
    /* chunky comic segmented control: acid-green active (black text), dark inactive (green text) */
    .sw-tabs{display:flex;gap:0;align-self:center;padding:3px;border:2.5px solid var(--edge);border-radius:13px;
      background:#12151c;box-shadow:0 3px 0 var(--edge);margin-bottom:12px;flex:none}
    .sw-tab{border:0;background:transparent;color:var(--acid);padding:9px 26px;border-radius:9px;cursor:pointer;
      font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;transition:background .12s,color .12s}
    .sw-tab.on{background:var(--acid);color:#0a0c10}
    .sw-tab:not(.on):hover{color:#eafcb0}
    /* scroll body: alternating tier headers + card grids */
    .sw-scroll{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;flex:1;
      padding:2px 2px 16px;scrollbar-width:thin;scrollbar-color:rgba(193,248,50,.4) transparent}
    .sw-scroll::-webkit-scrollbar{width:8px}
    .sw-scroll::-webkit-scrollbar-thumb{background:rgba(193,248,50,.4);border-radius:8px}
    .sw-tierhead{display:flex;align-items:center;gap:9px;padding:14px 4px 9px}
    .sw-tierhead:first-child{padding-top:2px}
    .sw-tierstars{display:flex;gap:1px;font-size:15px;line-height:1;letter-spacing:1px;text-shadow:0 0 8px currentColor}
    .sw-tiername{font:900 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase}
    .sw-tierrule{flex:1;height:2px;border-radius:2px;background:linear-gradient(90deg,currentColor,transparent)}
    .sw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
    /* card = ART tile + name bar. Rarity-colored chunky border. NO buttons — tap opens the sheet. */
    .sw-card{--tc:#9aa4b2;position:relative;display:flex;flex-direction:column;cursor:pointer;border-radius:13px;overflow:hidden;
      border:2.5px solid color-mix(in srgb,var(--tc) 64%,var(--edge));background:#12151c;
      box-shadow:0 4px 0 var(--edge),0 8px 18px rgba(0,0,0,.5);transition:transform .12s ease,box-shadow .12s ease}
    .sw-card:hover{transform:translateY(-3px);box-shadow:0 6px 0 var(--edge),0 12px 24px rgba(0,0,0,.6)}
    .sw-card:active{transform:translateY(-1px)}
    .sw-card.equipped{border-color:var(--acid);box-shadow:0 0 0 2px var(--acid),0 4px 0 var(--edge),0 10px 22px rgba(193,248,50,.28)}
    /* 3:4 art tile */
    .sw-art-wrap{position:relative;aspect-ratio:3/4;overflow:hidden;
      background:radial-gradient(120% 90% at 50% 8%,rgba(255,255,255,.06),transparent 60%),#0d1017}
    .sw-card.locked .sw-art-wrap{background:radial-gradient(120% 90% at 50% 12%,rgba(150,166,196,.22),transparent 62%),linear-gradient(180deg,#232a37,#151a24)}
    .sw-art{position:absolute;inset:6px;width:calc(100% - 12px);height:calc(100% - 12px);object-fit:contain;opacity:0;transition:opacity .3s ease}
    .sw-card.has-art .sw-art{opacity:1}
    /* SILHOUETTE: unowned = the real baked car crushed to a black shadow shape on the lighter tile */
    .sw-card.locked .sw-art{filter:brightness(0);opacity:.9}
    .sw-card.locked.has-art .sw-art{opacity:.9}
    .sw-fallback{position:absolute;inset:0;display:none;place-items:center;font:900 46px/1 'Chakra Petch',ui-monospace,monospace;color:rgba(150,166,196,.5)}
    .sw-card.no-art .sw-fallback{display:grid}
    .sw-card.no-art .sw-art-wrap{background:linear-gradient(180deg,#14171f,#0c0e14)}
    .sw-lock{position:absolute;top:6px;right:6px;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;
      color:#e8edf3;background:rgba(8,10,16,.72);border:1.5px solid rgba(255,255,255,.14)}
    .sw-eqtag{position:absolute;top:6px;left:6px;padding:3px 8px;border-radius:7px;
      font:900 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;color:#0a0c10;background:var(--acid);box-shadow:0 2px 6px rgba(0,0,0,.5)}
    /* name bar under the art */
    .sw-namebar{display:flex;flex-direction:column;gap:5px;padding:8px 9px 9px;border-top:2px solid var(--edge);background:#161a22}
    .sw-name{font:800 12px/1.05 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:#fff;text-transform:uppercase;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sw-card.locked .sw-name{color:var(--mut)}
    .sw-stars{display:flex;gap:1px;font-size:11px;line-height:1;letter-spacing:.5px}
    .sw-star{text-shadow:0 0 6px currentColor}
    /* sticky footer: WATCH & BET */
    .sw-foot{flex:none;padding:10px 0 max(12px,env(safe-area-inset-bottom));border-top:2px solid var(--edge);
      background:linear-gradient(0deg,#0a0c10,rgba(10,12,16,.2))}
    .sw-watch{width:100%;border:2.5px solid var(--edge);border-radius:13px;padding:15px;cursor:pointer;
      font:900 15px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#0a0c10;
      background:var(--acid);box-shadow:0 4px 0 var(--edge),0 8px 18px rgba(193,248,50,.28)}
    .sw-watch:hover{filter:brightness(1.05)}
    .sw-watch:active{transform:translateY(2px);box-shadow:0 2px 0 var(--edge)}
    /* ── ONE action surface: the bottom sheet (kills the per-card button repetition) ── */
    .sw-backdrop{position:fixed;inset:0;z-index:6;display:none;background:rgba(4,5,9,.72);backdrop-filter:blur(2px)}
    .sw-backdrop.on{display:block}
    .sw-sheet{--tc:#9aa4b2;position:fixed;left:0;right:0;bottom:0;z-index:7;transform:translateY(102%);transition:transform .26s cubic-bezier(.2,.8,.25,1);
      display:flex;flex-direction:column;gap:13px;padding:16px 16px max(18px,env(safe-area-inset-bottom));
      background:#0f1219;border-top:3px solid var(--tc);border-radius:20px 20px 0 0;box-shadow:0 -16px 40px rgba(0,0,0,.7);
      max-height:88vh;overflow-y:auto}
    .sw-sheet.on{transform:translateY(0)}
    .sw-sheet-x{position:absolute;top:12px;right:12px;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:9px;cursor:pointer;
      color:#e8edf3;background:rgba(255,255,255,.08);font:700 15px/1 'Chakra Petch',ui-monospace,monospace}
    .sw-sheet-x:hover{background:rgba(255,255,255,.16)}
    .sw-sheet-art{position:relative;align-self:center;width:min(260px,64vw);aspect-ratio:3/4;border-radius:14px;overflow:hidden;
      border:2.5px solid color-mix(in srgb,var(--tc) 64%,var(--edge,#05070b));
      background:radial-gradient(120% 90% at 50% 8%,rgba(255,255,255,.06),transparent 60%),#0d1017}
    .sw-sheet-art.locked{background:radial-gradient(120% 90% at 50% 12%,rgba(150,166,196,.22),transparent 62%),linear-gradient(180deg,#232a37,#151a24)}
    .sw-sheet-art .sw-art{position:absolute;inset:10px;width:calc(100% - 20px);height:calc(100% - 20px);object-fit:contain;opacity:1;transition:none}
    .sw-sheet-art.locked .sw-art{filter:brightness(0);opacity:.9}
    .sw-sheet-art .sw-fallback{font-size:64px}
    .sw-sheet-art.no-art .sw-fallback{display:grid}
    .sw-sheet-art .sw-lock{width:34px;height:34px;top:9px;right:9px}
    .sw-sheet-head{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
    .sw-sheet-name{font:900 22px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.02em;color:#fff;text-transform:uppercase}
    .sw-sheet-stars{display:flex;gap:3px;font-size:19px;line-height:1}
    .sw-sheet-tier{font:900 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;text-shadow:0 0 10px currentColor}
    .sw-perk{display:flex;align-items:flex-start;gap:11px;padding:11px 13px;border-radius:12px;
      background:rgba(193,248,50,.07);border:1.5px solid rgba(193,248,50,.32)}
    .sw-perk-ic{display:flex;color:var(--acid,#c1f832);margin-top:1px;flex:none;filter:drop-shadow(0 0 5px rgba(193,248,50,.5))}
    .sw-perk-tx{display:flex;flex-direction:column;gap:3px;min-width:0}
    .sw-perk-name{font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;color:var(--acid,#c1f832);text-transform:uppercase}
    .sw-perk-desc{font:500 11px/1.35 'Chakra Petch',ui-monospace,monospace;color:rgba(216,222,255,.72)}
    .sw-sheet-acts{display:flex;gap:10px}
    .sw-act{flex:1;border:2.5px solid var(--edge,#05070b);border-radius:12px;padding:14px 8px;cursor:pointer;white-space:nowrap;
      font:900 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}
    .sw-act.race{color:#0a0c10;background:var(--acid,#c1f832);box-shadow:0 3px 0 var(--edge,#05070b)}
    .sw-act.drive{color:#e8edf3;background:#1b202a;box-shadow:0 3px 0 var(--edge,#05070b)}
    .sw-act.crates{color:#0a0c10;background:var(--acid,#c1f832);box-shadow:0 3px 0 var(--edge,#05070b)}
    .sw-act:hover{filter:brightness(1.08)}
    .sw-act:active{transform:translateY(2px);box-shadow:0 1px 0 var(--edge,#05070b)}
    .sw-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:31;
      padding:12px 22px;border-radius:12px;font:800 15px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.05em;
      background:rgba(10,12,16,.95);border:2px solid var(--acid,#c1f832);color:var(--acid,#c1f832);
      text-shadow:0 0 10px rgba(193,248,50,.4);opacity:0;pointer-events:none;transition:opacity .2s ease}
  `;
  document.head.appendChild(s);
}

export function createHome(parent: HTMLElement, deps: HomeDeps): Home {
  injectStyles();

  const el = document.createElement("div");
  el.className = "sw-home";
  el.dataset.home = "1";

  // ── header: the transparent-alpha Slopwheels wordmark (no black plate) ──
  const head = document.createElement("div");
  head.className = "sw-head";
  const wordmark = document.createElement("img");
  wordmark.className = "sw-wordmark";
  wordmark.src = "/assets/brands/slopwheels-alpha.png";
  wordmark.alt = "Slopwheels";
  head.appendChild(wordmark);
  el.appendChild(head);

  // ── tab strip: [Collection] [Store] segmented control. Store is a passthrough to the crate overlay;
  //    Collection is the only rendered content, so tapping Store never swaps the grid out from under it. ──
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

  // ── collection body: tier sections (5★ first) ──
  const scroll = document.createElement("div");
  scroll.className = "sw-scroll";
  el.appendChild(scroll);

  // ── sticky footer: Watch & bet ──
  const foot = document.createElement("div");
  foot.className = "sw-foot";
  const watchBtn = document.createElement("button");
  watchBtn.className = "sw-watch";
  watchBtn.textContent = "Watch & bet";
  foot.appendChild(watchBtn);
  el.appendChild(foot);

  // ── the ONE action surface: a bottom sheet raised by tapping any card ──
  const backdrop = document.createElement("div");
  backdrop.className = "sw-backdrop";
  const sheet = document.createElement("div");
  sheet.className = "sw-sheet";
  el.append(backdrop, sheet);

  const toastEl = document.createElement("div");
  toastEl.className = "sw-toast";
  el.appendChild(toastEl);

  parent.appendChild(el);

  // Opening the store hides home (the crate overlay sits BELOW home's z-index); crateBox.onClose
  // brings home back via show(), which also picks up any car just pulled from the crate.
  const openStore = () => { closeSheet(); hide(); deps.onOpenStore(); };

  onTap(storeTab, openStore);
  onTap(watchBtn, () => deps.onWatchAndBet());

  // star row (★ × rarity) tinted in the tier color; `size` in px. ★ is a static glyph (no user data).
  const addStars = (host: HTMLElement, rarity: number, color: string) => {
    for (let i = 0; i < rarity; i++) {
      const st = document.createElement("span");
      st.className = "sw-star";
      st.textContent = "★";
      st.style.color = color;
      host.appendChild(st);
    }
  };

  // ── bottom action sheet: the single place any car's actions live ──
  function closeSheet() {
    backdrop.classList.remove("on");
    sheet.classList.remove("on");
  }
  function openSheet(c: CarOption) {
    const owned = deps.owns(c.name);
    const display = carDisplayName(c);
    const rarity = tierOf(c.rarity).id;
    const tier = tierOf(rarity);
    sheet.style.setProperty("--tc", tier.color);

    const x = document.createElement("button");
    x.className = "sw-sheet-x";
    x.setAttribute("aria-label", "Close");
    x.textContent = "✕";
    onTap(x, closeSheet);

    // larger art (silhouette if unowned)
    const artWrap = document.createElement("div");
    artWrap.className = "sw-sheet-art" + (owned ? "" : " locked");
    const fallback = document.createElement("div");
    fallback.className = "sw-fallback";
    fallback.textContent = "?";
    const art = document.createElement("img");
    art.className = "sw-art";
    art.alt = display;
    art.src = `/cards/${cardSlug(display)}.png`;
    art.addEventListener("error", () => { art.remove(); artWrap.classList.add("no-art"); });
    artWrap.append(fallback, art);
    if (!owned) {
      const lock = document.createElement("div");
      lock.className = "sw-lock";
      lock.innerHTML = LOCK_SVG; // static glyph, no dynamic data
      artWrap.appendChild(lock);
    }

    // name + star row + tier label
    const headRow = document.createElement("div");
    headRow.className = "sw-sheet-head";
    const nm = document.createElement("div");
    nm.className = "sw-sheet-name";
    nm.textContent = display; // textContent — never inject a name as HTML
    const stars = document.createElement("div");
    stars.className = "sw-sheet-stars";
    addStars(stars, rarity, tier.color);
    const tierLbl = document.createElement("div");
    tierLbl.className = "sw-sheet-tier";
    tierLbl.textContent = tier.name;
    tierLbl.style.color = tier.color;
    headRow.append(nm, stars, tierLbl);

    const parts: HTMLElement[] = [x, artWrap, headRow];

    // perk info (when the car has a power) — icon id is a developer constant; name/desc via textContent
    if (c.power) {
      const perk = document.createElement("div");
      perk.className = "sw-perk";
      const ic = document.createElement("span");
      ic.className = "sw-perk-ic";
      ic.innerHTML = icon(c.power.icon, 20);
      const tx = document.createElement("div");
      tx.className = "sw-perk-tx";
      const pn = document.createElement("div");
      pn.className = "sw-perk-name";
      pn.textContent = c.power.name;
      const pd = document.createElement("div");
      pd.className = "sw-perk-desc";
      pd.textContent = c.power.desc;
      tx.append(pn, pd);
      perk.append(ic, tx);
      parts.push(perk);
    }

    // actions: owned → Enter race + Drive lobby ; unowned → Get crates
    const acts = document.createElement("div");
    acts.className = "sw-sheet-acts";
    if (owned) {
      const race = document.createElement("button");
      race.className = "sw-act race";
      race.textContent = "Enter race";
      onTap(race, () => { closeSheet(); deps.onEnterRace(c.name); });
      const drive = document.createElement("button");
      drive.className = "sw-act drive";
      drive.textContent = "Drive lobby";
      onTap(drive, () => { closeSheet(); deps.onDriveLobby(c.name); });
      acts.append(race, drive);
    } else {
      const get = document.createElement("button");
      get.className = "sw-act crates";
      get.textContent = "Get crates";
      onTap(get, openStore);
      acts.appendChild(get);
    }
    parts.push(acts);

    sheet.replaceChildren(...parts);
    backdrop.classList.add("on");
    sheet.classList.add("on");
  }
  onTap(backdrop, closeSheet);

  // ── card: pure ART tile + name bar. No buttons — the whole card is a tap target for the sheet. ──
  const buildCard = (c: CarOption): HTMLElement => {
    const owned = deps.owns(c.name);
    const display = carDisplayName(c);
    const rarity = tierOf(c.rarity).id;
    const tier = tierOf(rarity);
    const card = document.createElement("div");
    // the equipped ring is OWNED-only: the boot road model defaults to an unowned car (e.g. DeLorean
    // for a fresh guest), and a dimmed locked card must never wear the acid-green "equipped" ring.
    const equipped = owned && c.name === deps.equippedName();
    card.className = "sw-card" + (owned ? " owned" : " locked") + (equipped ? " equipped" : "");
    card.style.setProperty("--tc", tier.color);

    // art tile: baked PNG (brightness(0) silhouette when unowned); "?" only if the PNG is missing
    const wrap = document.createElement("div");
    wrap.className = "sw-art-wrap";
    const fallback = document.createElement("div");
    fallback.className = "sw-fallback";
    fallback.textContent = "?";
    wrap.appendChild(fallback);
    const art = document.createElement("img");
    art.className = "sw-art";
    art.alt = display;
    art.src = `/cards/${cardSlug(display)}.png`;
    art.addEventListener("load", () => card.classList.add("has-art"));
    art.addEventListener("error", () => { art.remove(); card.classList.add("no-art"); }); // missing bake → "?" card
    wrap.appendChild(art);
    if (!owned) {
      const lock = document.createElement("div");
      lock.className = "sw-lock";
      lock.innerHTML = LOCK_SVG;
      wrap.appendChild(lock);
    }
    if (equipped) {
      const tag = document.createElement("div");
      tag.className = "sw-eqtag";
      tag.textContent = "EQUIPPED";
      wrap.appendChild(tag);
    }
    card.appendChild(wrap);

    // name bar: name + star row (fully visible even when locked — the rarity always reads)
    const bar = document.createElement("div");
    bar.className = "sw-namebar";
    const name = document.createElement("span");
    name.className = "sw-name";
    name.textContent = display;
    const stars = document.createElement("span");
    stars.className = "sw-stars";
    addStars(stars, rarity, tier.color);
    bar.append(name, stars);
    card.appendChild(bar);

    onTap(card, () => openSheet(c));
    return card;
  };

  const render = () => {
    scroll.replaceChildren(); // fresh build → old card elements + their listeners are discarded
    for (const group of groupByTier(deps.cars(), deps.owns)) {
      const tier = tierOf(group.rarity);
      const headRow = document.createElement("div");
      headRow.className = "sw-tierhead";
      headRow.style.color = tier.color;
      const stars = document.createElement("span");
      stars.className = "sw-tierstars";
      addStars(stars, group.rarity, tier.color);
      const label = document.createElement("span");
      label.className = "sw-tiername";
      label.textContent = tier.name;
      const rule = document.createElement("span");
      rule.className = "sw-tierrule";
      headRow.append(stars, label, rule);
      scroll.appendChild(headRow);

      const grid = document.createElement("div");
      grid.className = "sw-grid";
      for (const c of group.cars) grid.appendChild(buildCard(c));
      scroll.appendChild(grid);
    }
  };

  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function show() {
    render();
    closeSheet();                       // never re-open home with a stale sheet raised
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
