import { browserStore, type KvStore } from "../core/identity";

// First-run onboarding walkthrough: a 5-card paged explainer in plain player terms, reusing the
// game's real on-screen labels. Shown once to new players (flag below) and from the hamburger menu.
const KEY = "raider.howto.v1";
/** true once the walkthrough has been shown/skipped (persists across reload / logout). */
export function howToSeen(store: KvStore = browserStore): boolean { return store.get(KEY) === "1"; }
/** mark the walkthrough as seen (also grandfathers a returning player). */
export function markHowToSeen(store: KvStore = browserStore): void { store.set(KEY, "1"); }

interface LobbyStop {
  key: "track" | "garage" | "upgrades" | "crates";
  label: string;
  copy: string;
  color: string;
}

interface Card {
  title: string;
  body: string;
  media: string;
  poster: string;
  stops?: LobbyStop[];
}

const CARDS: Card[] = [
  {
    title: "Take the wheel",
    body: "Hold to drive. Drag left or right to steer.",
    media: "/tutorial/drive",
    poster: "/tutorial/drive.webp",
  },
  {
    title: "Know the strip",
    body: "Four stops. One quick tour.",
    media: "/tutorial/lobby",
    poster: "/tutorial/lobby.webp",
    stops: [
      { key: "track", label: "TRACK", copy: "start a price race", color: "#14f195" },
      { key: "garage", label: "GARAGE", copy: "choose your car", color: "#27e7ff" },
      { key: "upgrades", label: "UPGRADES", copy: "increase risk and time", color: "#ffd166" },
      { key: "crates", label: "CRATES", copy: "unlock new cars", color: "#ff39c0" },
    ],
  },
  {
    title: "Call the market",
    body: "Long if price goes up. Short if it goes down. Then tap GO.",
    media: "/tutorial/market-side",
    poster: "/tutorial/market-side.webp",
  },
  {
    title: "Choose your risk",
    body: "More revs means more leverage. Bigger wins, faster wrecks.",
    media: "/tutorial/leverage",
    poster: "/tutorial/leverage.webp",
  },
  {
    title: "Bank it before you wreck",
    body: "Cash out to keep the win. Hit liquidation and lose the play amount.",
    media: "/tutorial/cash-out",
    poster: "/tutorial/cash-out.webp",
  },
];

export interface HowToOptions {
  reducedMotion?: () => boolean;
}

function stopsHtml(stops: LobbyStop[] | undefined): string {
  if (!stops) return "";
  return `<div class="ht-stops">${stops.map((stop) =>
    `<div class="ht-stop" data-stop="${stop.key}" style="--stop:${stop.color}">` +
      `<b>${stop.label}</b><small>${stop.copy}</small>` +
    `</div>`
  ).join("")}</div>`;
}

function mediaHtml(card: Card, next: Card | undefined, reducedMotion: boolean): string {
  const active = reducedMotion ? "" :
    `<video class="ht-video" muted loop playsinline autoplay preload="auto" poster="${card.poster}">` +
      `<source src="${card.media}.webm" type="video/webm">` +
      `<source src="${card.media}.mp4" type="video/mp4">` +
    `</video>` +
    `<button class="ht-play" data-ht="play" aria-label="Play tutorial clip" hidden>▶</button>`;
  const preload = !reducedMotion && next ?
    `<video class="ht-preload" aria-hidden="true" muted preload="metadata">` +
      `<source src="${next.media}.webm" type="video/webm">` +
    `</video>` : "";
  return `<div class="ht-media">` +
    `<img class="ht-poster" src="${card.poster}" alt="">` +
    active + preload +
  `</div>`;
}

export interface HowTo { open(onClose?: () => void): void; isOpen(): boolean }

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return; stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes htIn{0%{transform:translateY(12px);opacity:0}100%{transform:translateY(0);opacity:1}}
    .ht-panel{width:min(400px,94vw);max-height:calc(100dvh - 40px);overflow:auto;padding:20px 20px 16px;display:flex;flex-direction:column;align-items:center;gap:12px;background:rgba(12,10,26,.96);border:1.5px solid rgba(39,231,255,.4);border-radius:18px;box-shadow:0 0 34px rgba(39,231,255,.22);position:relative}
    .ht-skip{position:absolute;top:12px;right:14px;cursor:pointer;border:0;background:transparent;color:#8a8aa0;font:700 12px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.1em}
    .ht-media{position:relative;width:100%;aspect-ratio:16/9;max-height:202px;margin-top:8px;overflow:hidden;border:1px solid rgba(39,231,255,.28);border-radius:12px;background:#080713;box-shadow:inset 0 0 24px rgba(0,0,0,.55);animation:htIn .35s ease both}
    .ht-poster,.ht-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .ht-poster{z-index:0}.ht-video{z-index:1}.ht-video[hidden]{display:none}
    .ht-play{position:absolute;z-index:2;left:50%;top:50%;transform:translate(-50%,-50%);width:52px;height:52px;border:1px solid rgba(39,231,255,.65);border-radius:50%;background:rgba(8,7,19,.88);color:#fff;cursor:pointer;font:800 18px/1 'Chakra Petch',ui-monospace,monospace;box-shadow:0 0 18px rgba(39,231,255,.34)}
    .ht-play[hidden],.ht-preload{display:none}
    .ht-t{font:800 22px/1 'Chakra Petch',ui-monospace,monospace;color:#fff;letter-spacing:.04em;text-shadow:0 0 12px rgba(39,231,255,.5);animation:htIn .35s ease .04s both}
    .ht-body{min-height:0;text-align:center;font:500 15px/1.45 'Chakra Petch',ui-monospace,monospace;color:#c9cce0;animation:htIn .35s ease .08s both}
    .ht-body b{color:#fff}
    .ht-stops{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;width:100%}
    .ht-stop{padding:8px 7px;border:1px solid color-mix(in srgb,var(--stop) 45%,transparent);border-radius:8px;background:rgba(255,255,255,.04);text-align:left}
    .ht-stop b{display:block;color:var(--stop);font:700 10px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.07em}
    .ht-stop small{display:block;margin-top:4px;color:#9d9aaf;font:500 9px/1.2 'Chakra Petch',ui-monospace,monospace}
    .ht-dots{display:flex;gap:7px}
    .ht-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.22)}
    .ht-dot.on{background:#27e7ff;box-shadow:0 0 8px #27e7ff}
    .ht-nav{display:flex;gap:10px;width:100%;margin-top:4px}
    .ht-prev{flex:none;width:52px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:rgba(255,255,255,.06);color:#c9cce0;cursor:pointer;font:800 16px/1 'Chakra Petch',ui-monospace,monospace}
    .ht-prev:disabled{opacity:.3;cursor:not-allowed}
    .ht-next{flex:1;border:0;border-radius:11px;padding:13px;cursor:pointer;font:800 14px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 4px 14px rgba(46,230,166,.34)}
    @media(max-height:620px){.ht-media{max-height:150px}.ht-panel{gap:9px}}
  `;
  document.head.appendChild(s);
}

export function createHowTo(parent: HTMLElement, options: HowToOptions = {}): HowTo {
  injectStyles();
  const overlay = document.createElement("div");
  overlay.style.cssText = ["position:fixed","inset:0","z-index:12","display:none","align-items:center","justify-content:center","padding:20px","background:rgba(0,0,0,.84)","backdrop-filter:blur(3px)","pointer-events:auto"].join(";");
  const panel = document.createElement("div");
  panel.className = "ht-panel";
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  let i = 0;
  let closer: (() => void) | undefined;
  const reducedMotion = options.reducedMotion?.() ??
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

  let activeVideo: HTMLVideoElement | null = null;
  let activePlay: HTMLButtonElement | null = null;

  const pauseActive = () => {
    activeVideo?.pause();
    activeVideo = null;
    activePlay = null;
  };

  const playActive = () => {
    const video = activeVideo;
    const playButton = activePlay;
    if (!video || !playButton) return;
    const attempt = video.play();
    void attempt.then(() => {
      if (video === activeVideo) playButton.hidden = true;
    }).catch(() => {
      if (video === activeVideo) playButton.hidden = false;
    });
  };

  const activateMedia = () => {
    const frame = panel.querySelector<HTMLElement>(".ht-media");
    activeVideo = panel.querySelector<HTMLVideoElement>(".ht-video");
    activePlay = panel.querySelector<HTMLButtonElement>(".ht-play");
    if (!frame || !activeVideo || !activePlay) return;

    const video = activeVideo;
    const playButton = activePlay;
    video.addEventListener("error", () => {
      if (video !== activeVideo) return;
      frame.classList.add("is-fallback");
      video.hidden = true;
      playButton.hidden = true;
      activeVideo = null;
      activePlay = null;
    }, { once: true });
    playActive();
  };

  const render = () => {
    pauseActive();
    const card = CARDS[i];
    const last = i === CARDS.length - 1;
    panel.innerHTML =
      `<button class="ht-skip" data-ht="skip" aria-label="Skip">SKIP</button>` +
      mediaHtml(card, CARDS[i + 1], reducedMotion) +
      `<div class="ht-t">${card.title}</div>` +
      `<div class="ht-body">${card.body}</div>` +
      stopsHtml(card.stops) +
      `<div class="ht-dots">${CARDS.map((_, index) =>
        `<span class="ht-dot${index === i ? " on" : ""}"></span>`
      ).join("")}</div>` +
      `<div class="ht-nav">` +
        `<button class="ht-prev" data-ht="prev"${i === 0 ? " disabled" : ""}>‹</button>` +
        `<button class="ht-next" data-ht="next">${last ? "LET'S GO" : "NEXT ›"}</button>` +
      `</div>`;
    activateMedia();
  };
  const close = () => {
    pauseActive();
    overlay.style.display = "none";
    const cb = closer;
    closer = undefined;
    cb?.();
  };
  const go = (d: number) => { i = Math.max(0, Math.min(CARDS.length - 1, i + d)); render(); };

  panel.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-ht]") as HTMLElement | null;
    if (!el) return;
    const k = el.dataset.ht;
    if (k === "play") playActive();
    else if (k === "skip") close();
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
