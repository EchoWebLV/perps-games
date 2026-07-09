import { browserStore, type KvStore } from "../core/identity";

// First-run onboarding walkthrough: a 6-card paged explainer in plain player terms, reusing the
// game's real on-screen labels. Shown once to new players (flag below) and from the hamburger menu.
const KEY = "raider.howto.v1";
/** true once the walkthrough has been shown/skipped (persists across reload / logout). */
export function howToSeen(store: KvStore = browserStore): boolean { return store.get(KEY) === "1"; }
/** mark the walkthrough as seen (also grandfathers a returning player). */
export function markHowToSeen(store: KvStore = browserStore): void { store.set(KEY, "1"); }

interface Card { ic: string; t: string; body: string; sub?: string }
const CARDS: Card[] = [
  { ic: "🏎️", t: "Drive", body: "Hold the road to drive. Drag to steer, pull back to brake, release to coast.", sub: "Keyboard: W/S gas &amp; brake, A/D steer." },
  { ic: "📈", t: "Race the price", body: "Drive into <b>TRACK</b>. Call it: <b>▲ Long</b> if the price goes up, <b>▼ Short</b> if it drops. Set your <b>play amount</b>, then tap <b>GO!</b>" },
  { ic: "⚡", t: "Rev for leverage", body: "Hold the gas to rev — more revs = higher leverage (<b>×</b>), and every price move hits bigger. The dial shows your leverage." },
  { ic: "💰", t: "Win or wreck", body: "The big number is your live multiplier — <b>green</b> when you're up, <b>red</b> when you're down. Tap <b>CASH OUT</b> while you're up to bank it. Drop too far and you're <b>💥 Liquidated</b> — you lose the play amount. Beat the clock." },
  { ic: "🎮", t: "Practice or real", body: "As a guest you're in <b>practice</b> mode — free, nothing at stake. <b>Sign in</b> to play for real SOL." },
  { ic: "🎁", t: "Earn &amp; upgrade", body: "Grab <b>coins</b> and <b>scrap</b> on the track. Spend coins at <b>UPGRADES</b> (more leverage, longer rounds) and <b>CRATES</b> (win new cars). Find your ride in the <b>GARAGE</b>." },
];

export interface HowTo { open(onClose?: () => void): void; isOpen(): boolean }

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return; stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes htIn{0%{transform:translateY(12px);opacity:0}100%{transform:translateY(0);opacity:1}}
    .ht-panel{width:min(400px,94vw);padding:20px 20px 16px;display:flex;flex-direction:column;align-items:center;gap:12px;background:rgba(12,10,26,.96);border:1.5px solid rgba(39,231,255,.4);border-radius:18px;box-shadow:0 0 34px rgba(39,231,255,.22);position:relative}
    .ht-skip{position:absolute;top:12px;right:14px;cursor:pointer;border:0;background:transparent;color:#8a8aa0;font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em}
    .ht-ic{font-size:52px;line-height:1;margin-top:8px;animation:htIn .35s ease both}
    .ht-t{font:800 22px/1 'Chakra Petch',ui-monospace,monospace;color:#fff;letter-spacing:.04em;text-shadow:0 0 12px rgba(39,231,255,.5);animation:htIn .35s ease .04s both}
    .ht-body{min-height:96px;text-align:center;font:500 15px/1.5 'Chakra Petch',ui-monospace,monospace;color:#c9cce0;animation:htIn .35s ease .08s both}
    .ht-body b{color:#fff}
    .ht-sub{font-size:12px;color:#8a8aa0;margin-top:6px}
    .ht-dots{display:flex;gap:7px}
    .ht-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.22)}
    .ht-dot.on{background:#27e7ff;box-shadow:0 0 8px #27e7ff}
    .ht-nav{display:flex;gap:10px;width:100%;margin-top:4px}
    .ht-prev{flex:none;width:52px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:rgba(255,255,255,.06);color:#c9cce0;cursor:pointer;font:800 16px/1 'Chakra Petch',ui-monospace,monospace}
    .ht-prev:disabled{opacity:.3;cursor:not-allowed}
    .ht-next{flex:1;border:0;border-radius:11px;padding:13px;cursor:pointer;font:800 14px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 4px 14px rgba(46,230,166,.34)}
  `;
  document.head.appendChild(s);
}

export function createHowTo(parent: HTMLElement): HowTo {
  injectStyles();
  const overlay = document.createElement("div");
  overlay.style.cssText = ["position:fixed","inset:0","z-index:12","display:none","align-items:center","justify-content:center","padding:20px","background:rgba(0,0,0,.84)","backdrop-filter:blur(3px)"].join(";");
  const panel = document.createElement("div");
  panel.className = "ht-panel";
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  let i = 0;
  let closer: (() => void) | undefined;
  const render = () => {
    const c = CARDS[i];
    const last = i === CARDS.length - 1;
    panel.innerHTML =
      `<button class="ht-skip" data-ht="skip" aria-label="Skip">SKIP</button>` +
      `<div class="ht-ic">${c.ic}</div>` +
      `<div class="ht-t">${c.t}</div>` +
      `<div class="ht-body">${c.body}${c.sub ? `<div class="ht-sub">${c.sub}</div>` : ""}</div>` +
      `<div class="ht-dots">${CARDS.map((_, k) => `<span class="ht-dot${k === i ? " on" : ""}"></span>`).join("")}</div>` +
      `<div class="ht-nav">` +
        `<button class="ht-prev" data-ht="prev"${i === 0 ? " disabled" : ""}>‹</button>` +
        `<button class="ht-next" data-ht="next">${last ? "Let's go" : "Next ›"}</button>` +
      `</div>`;
  };
  const close = () => { overlay.style.display = "none"; const cb = closer; closer = undefined; cb?.(); };
  const go = (d: number) => { i = Math.max(0, Math.min(CARDS.length - 1, i + d)); render(); };

  panel.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-ht]") as HTMLElement | null;
    if (!el) return;
    const k = el.dataset.ht;
    if (k === "skip") close();
    else if (k === "prev") go(-1);
    else if (k === "next") { if (i === CARDS.length - 1) close(); else go(1); }
  });
  // swipe (a real drag, not a tap on a button)
  let sx = 0;
  overlay.addEventListener("pointerdown", (e) => { sx = e.clientX; });
  overlay.addEventListener("pointerup", (e) => { const dx = e.clientX - sx; if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1); });
  // arrow keys / Esc, only while open
  addEventListener("keydown", (e) => {
    if (overlay.style.display === "none") return;
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "Escape") close();
  });

  return {
    open(onClose) { closer = onClose; i = 0; render(); overlay.style.display = "flex"; },
    isOpen: () => overlay.style.display !== "none",
  };
}
