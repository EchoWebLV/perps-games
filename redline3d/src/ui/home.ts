// The Slopwheels boot hub: a small OG neon page. Race is one tap onto the Perps Track.
// Cars / Crates / Upgrades open existing overlays. Lobby is hangout. No collection grid,
// no Grand Prix. Pure DOM — home must cost nothing on the GPU.
import type { CarOption } from "./carpicker";
import { tierOf } from "../core/rarity";
import { onTap } from "./tap";

export interface HomeDeps {
  onRace: () => void;
  onCars: () => void;
  onCrates: () => void;
  onUpgrades: () => void;
  onLobby: () => void;
  onConnectWallet?: () => void;
}
export interface Home {
  el: HTMLElement;
  show(): void;
  hide(): void;
  isOpen(): boolean;
  setBusy(busy: boolean): void;
  dispose(): void;
}

/** Slug a card's DISPLAY name exactly like scripts/bake-cards.mjs (~L87). */
export const cardSlug = (displayName: string): string =>
  displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export interface TierGroup { rarity: number; cars: CarOption[]; }
/** Arrange the roster BY STARS — kept for garage/card tools; the hub itself does not render cards. */
export function groupByTier(defs: CarOption[], owns: (n: string) => boolean): TierGroup[] {
  const byRarity = new Map<number, CarOption[]>();
  for (const c of defs) {
    const r = tierOf(c.rarity).id;
    (byRarity.get(r) ?? byRarity.set(r, []).get(r)!).push(c);
  }
  const groups: TierGroup[] = [];
  for (let r = 5; r >= 1; r--) {
    const cars = byRarity.get(r);
    if (!cars?.length) continue;
    cars.sort((a, b) => {
      const ao = owns(a.name) ? 1 : 0, bo = owns(b.name) ? 1 : 0;
      if (ao !== bo) return bo - ao;
      return a.name.localeCompare(b.name);
    });
    groups.push({ rarity: r, cars });
  }
  return groups;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .sw-home{--lime:#c1f832;--ink:#e8edf3;--mut:#7a889c;--edge:#0a0618;
      position:fixed;inset:0;z-index:30;display:none;flex-direction:column;align-items:center;justify-content:center;
      pointer-events:auto;gap:22px;padding:max(18px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));
      background:radial-gradient(90% 60% at 50% 0%,rgba(193,248,50,.16),transparent 55%),#05030d;
      color:var(--ink);font-family:'Chakra Petch',ui-monospace,monospace}
    .sw-home.on{display:flex}
    .sw-head{display:flex;flex-direction:column;align-items:center;gap:10px}
    .sw-wordmark{height:104px;width:auto;max-width:92vw;object-fit:contain;filter:drop-shadow(0 0 22px rgba(193,248,50,.45))}
    .sw-connect{border:1px solid rgba(193,248,50,.45);background:rgba(8,16,8,.7);color:var(--lime);
      padding:6px 12px;border-radius:999px;cursor:pointer;font:700 11px/1 'Chakra Petch',monospace;letter-spacing:.14em;text-transform:uppercase}
    .sw-connect:hover{background:rgba(193,248,50,.12)}
    .sw-hub{display:flex;flex-direction:column;gap:10px;width:min(360px,92vw)}
    .sw-hub-btn{border:1px solid rgba(193,248,50,.42);border-radius:10px;padding:14px 16px;cursor:pointer;
      font:800 15px/1 'Chakra Petch',monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);
      background:rgba(8,14,8,.82);box-shadow:0 0 0 1px rgba(5,3,13,.8),0 8px 24px rgba(0,0,0,.45)}
    .sw-hub-btn:hover{border-color:var(--lime);color:#e8ff9a;background:rgba(193,248,50,.1)}
    .sw-hub-btn[data-hub="race"]{background:linear-gradient(180deg,rgba(193,248,50,.22),rgba(8,14,8,.9));
      border-color:var(--lime);color:#041018;font-size:18px;padding:18px 16px;text-shadow:0 0 12px rgba(193,248,50,.45)}
    .sw-hub-btn[data-hub="race"]:not(:disabled){color:#041018;background:linear-gradient(180deg,#c1f832,#8fb820)}
    .sw-hub-btn:disabled{opacity:.55;cursor:wait}
    .sw-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .sw-hub-sub{margin:0;color:var(--mut);font:600 11px/1.4 'Chakra Petch',monospace;letter-spacing:.08em;text-transform:uppercase;text-align:center}
  `;
  document.head.appendChild(s);
}

export function createHome(parent: HTMLElement, deps: HomeDeps): Home {
  injectStyles();

  const el = document.createElement("div");
  el.className = "sw-home";
  el.dataset.home = "1";

  const head = document.createElement("div");
  head.className = "sw-head";
  const wordmark = document.createElement("img");
  wordmark.className = "sw-wordmark";
  wordmark.src = "/assets/brands/slopwheels-alpha.png";
  wordmark.alt = "Slopwheels";
  head.appendChild(wordmark);
  if (deps.onConnectWallet) {
    const connect = document.createElement("button");
    connect.className = "sw-connect";
    connect.textContent = "Connect wallet";
    onTap(connect, () => deps.onConnectWallet?.());
    head.appendChild(connect);
  }
  el.appendChild(head);

  const hub = document.createElement("div");
  hub.className = "sw-hub";

  const mk = (key: string, label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "sw-hub-btn";
    b.dataset.hub = key;
    b.textContent = label;
    onTap(b, () => { if (!b.disabled) fn(); });
    return b;
  };

  const race = mk("race", "Race", () => deps.onRace());
  hub.appendChild(race);

  const row = document.createElement("div");
  row.className = "sw-row";
  row.append(
    mk("cars", "Cars", () => { hide(); deps.onCars(); }),
    mk("crates", "Crates", () => { hide(); deps.onCrates(); }),
    mk("upgrades", "Upgrades", () => { hide(); deps.onUpgrades(); }),
    mk("lobby", "Lobby", () => deps.onLobby()),
  );
  hub.appendChild(row);
  el.appendChild(hub);

  const sub = document.createElement("p");
  sub.className = "sw-hub-sub";
  sub.textContent = "Race the live price · hang out in the lobby";
  el.appendChild(sub);

  parent.appendChild(el);

  function show() { el.classList.add("on"); }
  function hide() { el.classList.remove("on"); }

  return {
    el,
    show,
    hide,
    isOpen: () => el.classList.contains("on"),
    setBusy(busy) {
      race.disabled = busy;
      race.textContent = busy ? "Building track…" : "Race";
    },
    dispose() { el.remove(); },
  };
}
