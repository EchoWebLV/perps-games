import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { tierOf } from "../core/rarity";
import { rollCrate, dupeScrap, pickLevel, clientRandom, CRATES, crateByKey, type CrateType, type CrateCar, type RandomnessProvider } from "../core/crate";
import { createRevealCar } from "./reveal-car";
import { createCrateCinematic, type CrateCinematicRun } from "./crate-cinematic";
import { scrapPileHtml, levelPosterHtml, type LevelPoster } from "./reveal-bits";
import { toonify, reclaimToonVariants } from "../render/toon";

// The Crate Shop: pick one of three crates (Wooden / Silver / Gold), buy with coins → roll a car by
// that crate's rarity odds + bank the crate's scrap → reveal. A NEW car unlocks in the garage; a
// DUPLICATE adds bonus scrap. Randomness is a RandomnessProvider (client RNG now, MagicBlock VRF
// behind the same port later). Silver and Gold can also be bought with confirmed devnet SOL.
export interface CrateBoxDeps {
  cars: () => CrateCar[];               // the roster to roll from (owned + not-yet-owned)
  grantCar: (name: string) => boolean;  // inventory.grant → true if NEWLY owned, false if a dupe
  unlockUI: (name: string) => void;     // garage.grant → flip the collection card to owned
  coins: () => number;
  spend: (n: number) => boolean;        // debit coins; false if the balance can't cover it
  addScrap: (n: number) => void;
  lockedLevels: () => string[];         // level-skin keys not yet owned (empty → nothing left to drop)
  grantLevel: (key: string) => void;    // unlock a level skin
  levelInfo: (key: string) => LevelPoster;   // theme palette for the reward poster
  lowTier: boolean;                          // weak-GPU tier → static car image instead of a live canvas
  /** Submit and confirm native devnet SOL before a paid VRF pull begins. */
  buyWithSol?: (crateKey: string, priceSol: number) => Promise<string>;
  onClose?: () => void;
  rng?: RandomnessProvider;
  /** signed-in VRF draws: () => null (guest / not connected) | draws(n) that resolves n uniform
   *  draws from MagicBlock VRF. Resolved PER OPEN so a mid-session sign-in upgrades the path. */
  vrfDraws?: () => (null | ((n: number) => Promise<number[]>));
  /** True for account-backed crates. These must never fall back to browser RNG. */
  vrfRequired?: () => boolean;
  /** Atomic server completion for a free signed-in welcome crate, called after VRF succeeds. */
  completeGift?: () => Promise<boolean>;
  /** quiet escrow for the VRF path (upgrades.holdCoins/settleHold) */
  holdCoins?: (n: number) => boolean;
  settleHold?: (n: number, commit: boolean) => void;
  /** surface a VRF failure to the player (toast) */
  onVrfFail?: (msg: string) => void;
}
export interface CrateBox {
  open(): void;
  /** first-login welcome: show the overlay and run a FREE Wooden open (no coin cost) */
  openGift(crateKey: string): void;
  isOpen(): boolean;
  /** hide during a live round (a GO must not launch behind it) */
  setBusy(busy: boolean): void;
}

export type CrateRandomnessMode = "vrf" | "client" | "blocked";

/** Signed-in crates fail closed; only guest practice may use browser randomness. */
export function crateRandomnessMode(vrfRequired: boolean, hasProvider: boolean): CrateRandomnessMode {
  if (hasProvider) return "vrf";
  return vrfRequired ? "blocked" : "client";
}

/** A free account reward is applied only after the once-per-account claim wins. */
export async function completeVrfReward(
  free: boolean,
  completeGift: (() => Promise<boolean>) | undefined,
  applyReward: () => boolean,
): Promise<boolean> {
  if (free && (!completeGift || !(await completeGift()))) return false;
  return applyReward();
}

/** Keep the player-facing failure actionable while retaining the raw error in the console. */
export function vrfFailureMessage(error: unknown, coinsHeld = true): string {
  const suffix = coinsHeld ? " Your coins were restored." : "";
  const cause = error instanceof Error && "cause" in error
    ? String((error as Error & { cause?: unknown }).cause ?? "")
    : "";
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${cause}`
    : String(error);
  if (/prior credit|insufficient (funds|lamports).*fee|insufficient.*balance/i.test(text)) {
    return `This wallet needs devnet SOL for VRF. Open Wallet, send a little SOL, then try again.${suffix}`;
  }
  if (/vrf_timeout/i.test(text)) return `The randomness oracle timed out. Try again.${suffix}`;
  if (/429|too many requests|failed to fetch|network/i.test(text)) {
    return `The devnet connection is busy. Try again shortly.${suffix}`;
  }
  return `The verified crate open failed. Try again.${suffix}`;
}

/** Translate wallet and devnet failures into useful payment messages without granting a reward. */
export function solPaymentFailureMessage(error: unknown, priceSol: number): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/reject|denied|cancel/i.test(text)) return "Payment cancelled. Your wallet was not charged.";
  if (/insufficient|0x1|debit/i.test(text)) {
    return `Your wallet needs at least ${priceSol} devnet SOL plus a network fee.`;
  }
  if (/unconfirmed|block height|expired/i.test(text)) {
    return "The devnet payment was not confirmed, so no crate was opened.";
  }
  if (/treasury_not_configured/i.test(text)) return "SOL crate payments are temporarily unavailable.";
  return "The devnet SOL payment failed. No crate was opened.";
}

const gems = (r: number) => {
  const c = tierOf(r).color;
  return Array.from({ length: r }, () => `<span class="cb-gem" style="background:${c};box-shadow:0 0 6px ${c}"></span>`).join("");
};
// per-tier drop odds for a crate — a coloured dot + its % (each crate's tierWeights sum to 100).
// Disclosure AT THE POINT OF PURCHASE: the crate shop is the one place crate odds belong.
const oddsLine = (c: CrateType) =>
  Object.entries(c.tierWeights).map(([k, w]) => {
    const col = tierOf(+k).color;
    return `<span class="cb-col-od" style="--tc:${col}"><i></i>${w}%</span>`;
  }).join("");

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    @keyframes cbCardIn{0%{transform:translateY(20px) scale(.6) rotateY(85deg);opacity:0}60%{transform:translateY(0) scale(1.05) rotateY(0);opacity:1}100%{transform:scale(1)}}
    @keyframes cbScrapIn{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}
    @keyframes cbGlow{0%,100%{opacity:.55}50%{opacity:.95}}
    @keyframes cbBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
    @keyframes cbSheen{0%,100%{background-position:150% 0}55%{background-position:-60% 0}}
    .cb-panel{width:min(560px,96vw);padding:16px;display:flex;flex-direction:column;gap:12px;background:rgba(12,10,26,.94);
      border-color:rgba(132,150,224,.28);pointer-events:auto;position:relative;overflow:hidden}
    .cb-head{display:flex;align-items:center;gap:10px}
    .cb-head .lbl{flex:1}
    .cb-coins{display:flex;align-items:center;gap:5px;font:700 14px/1 'Chakra Petch',ui-monospace,monospace;color:var(--amb);text-shadow:0 0 9px rgba(255,209,102,.5)}
    .cb-x{cursor:pointer;color:var(--mut);font:700 16px/1 'Chakra Petch',ui-monospace,monospace;padding:3px 5px;border:0;background:transparent}
    /* shop: three fancy crate columns */
    .cb-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .cb-col{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;gap:7px;padding:14px 8px 11px;border-radius:14px;
      cursor:default;transition:transform .18s ease,box-shadow .18s ease;border:1.5px solid color-mix(in srgb,var(--cc) 70%,transparent);
      background:linear-gradient(180deg,color-mix(in srgb,var(--cc) 17%,rgba(16,12,34,.92)),rgba(9,6,20,.97));
      box-shadow:0 0 16px color-mix(in srgb,var(--cc) 20%,transparent),inset 0 1px 0 color-mix(in srgb,var(--cc) 32%,transparent)}
    .cb-col:hover{transform:translateY(-4px);box-shadow:0 10px 28px color-mix(in srgb,var(--cc) 42%,transparent),inset 0 1px 0 color-mix(in srgb,var(--cc) 48%,transparent)}
    .cb-col-glow{position:absolute;top:2px;left:50%;transform:translateX(-50%);width:120px;height:120px;border-radius:50%;pointer-events:none;
      background:radial-gradient(circle,color-mix(in srgb,var(--cc) 55%,transparent),transparent 65%);opacity:.5}
    .cb-col-sheen{position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 38%,rgba(255,255,255,.13) 48%,transparent 58%);
      background-size:250% 100%;animation:cbSheen 5s ease-in-out infinite}
    .cb-col-crate{position:relative;width:82px;height:74px;background-size:contain;background-repeat:no-repeat;background-position:center;
      filter:drop-shadow(0 4px 10px color-mix(in srgb,var(--cc) 60%,transparent));animation:cbBob 3.4s ease-in-out infinite}
    .cb-col-nm{position:relative;font:800 15px/1 'Chakra Petch',ui-monospace,monospace;color:#fff;letter-spacing:.04em;text-shadow:0 0 10px color-mix(in srgb,var(--cc) 75%,transparent)}
    .cb-col-odds{display:flex;flex-wrap:wrap;justify-content:center;align-content:center;gap:3px 8px;min-height:21px}
    .cb-col-od{display:inline-flex;align-items:center;gap:3px;font:700 9px/1 'Chakra Petch',ui-monospace,monospace;color:rgba(226,230,255,.82)}
    .cb-col-od i{width:6px;height:6px;border-radius:50%;background:var(--tc);box-shadow:0 0 5px var(--tc);flex:none}
    .cb-col-scrap{font:700 11px/1 'Chakra Petch',ui-monospace,monospace;color:#c2cad6}
    .cb-col-buy{position:relative;display:flex;flex-direction:column;gap:5px;width:100%;margin-top:auto}
    .cb-coin{border:0;border-radius:9px;padding:9px 4px;cursor:pointer;font:800 12px/1 'Chakra Petch',ui-monospace,monospace;white-space:nowrap;width:100%;
      color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 3px 10px rgba(46,230,166,.32)}
    .cb-coin:disabled{cursor:not-allowed;color:var(--mut);background:rgba(255,255,255,.08);box-shadow:none}
    .cb-sol{border:1px solid rgba(255,209,102,.4);border-radius:9px;padding:7px 4px;cursor:pointer;font:800 11px/1 'Chakra Petch',ui-monospace,monospace;width:100%;
      color:var(--amb);background:rgba(255,209,102,.1)}
    /* reveal — the card is mounted inside the shared cinematic's slot; .cb-reveal gives it a column */
    .cb-reveal{display:flex;flex-direction:column;align-items:center;gap:14px;position:relative;justify-content:center;min-height:230px}
    .cb-vrf{display:inline-flex;align-items:center;gap:5px;margin-top:7px;padding:4px 9px;border-radius:6px;
      font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;color:#a7f0d9;
      background:rgba(20,199,140,.12);border:1px solid rgba(20,199,140,.4)}
    .cb-halo{position:absolute;top:8px;width:210px;height:210px;border-radius:50%;background:radial-gradient(circle,var(--tc),transparent 66%);opacity:.6;animation:cbGlow 2.4s ease-in-out infinite;pointer-events:none}
    .cb-card{position:relative;width:180px;padding:14px;border-radius:14px;text-align:center;background:linear-gradient(180deg,rgba(20,14,40,.96),rgba(10,7,22,.98));
      border:2px solid var(--tc);box-shadow:0 0 26px var(--tc);animation:cbCardIn .55s cubic-bezier(.22,1.2,.36,1) both}
    .cb-badge{display:inline-block;font:800 11px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;padding:4px 9px;border-radius:6px;margin-bottom:8px}
    .cb-badge.new{color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 0 12px rgba(46,230,166,.5)}
    .cb-badge.dupe{color:var(--amb);background:rgba(255,209,102,.14);border:1px solid rgba(255,209,102,.4)}
    .cb-tier{font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.16em;color:var(--tc);text-shadow:0 0 10px var(--tc)}
    .cb-gems{display:flex;gap:4px;justify-content:center;margin:8px 0}.cb-gem{width:9px;height:9px;border-radius:50%;display:inline-block}
    .cb-name{font:800 19px/1.1 'Chakra Petch',ui-monospace,monospace;color:#fff;text-shadow:0 0 12px var(--tc)}
    .cb-loot{display:flex;gap:9px;animation:cbScrapIn .4s ease-out .35s both}
    .cb-chip{display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:10px;background:rgba(18,14,40,.85);border:1px solid rgba(132,150,224,.3);
      font:800 14px/1 'Chakra Petch',ui-monospace,monospace;color:#c2cad6}
    .cb-chip b{color:#e6ecf7}
    .cb-lvl{border-color:var(--l1);color:#fff;background:linear-gradient(120deg,color-mix(in srgb,var(--l1) 45%,rgba(18,14,40,.9)),color-mix(in srgb,var(--l2) 45%,rgba(18,14,40,.9)));box-shadow:0 0 12px color-mix(in srgb,var(--l1) 45%,transparent)}
    .cb-lvl b{color:#fff}
    .cb-btns{display:flex;gap:9px;width:100%}
    .cb-btn{flex:1;border:0;border-radius:10px;padding:12px;cursor:pointer;font:800 13px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;
      color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 4px 14px rgba(46,230,166,.34)}
    .cb-btn:disabled{cursor:not-allowed;color:var(--mut);background:rgba(255,255,255,.08);box-shadow:none}
    .cb-btn.ghost{color:var(--ink);background:rgba(255,255,255,.08);box-shadow:none}
    .cb-hero{width:220px;height:220px;display:flex;align-items:center;justify-content:center;animation:cbCardIn .5s cubic-bezier(.22,1.2,.36,1) both}
    .cb-plate{display:flex;flex-direction:column;align-items:center;gap:6px}
    .cb-halo.big{width:300px;height:300px;top:-14px}
    .cb-loot{align-items:flex-end}
    .cb-scrap{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:96px;padding:10px 12px;border-radius:12px;background:rgba(18,14,40,.7);border:1px solid rgba(132,150,224,.28)}
    .cb-scrap-heap{position:relative;width:80px;height:34px}
    .cb-shard{position:absolute;background:var(--sc);border-radius:2px;box-shadow:0 0 4px rgba(154,164,178,.4)}
    .cb-scrap-n{font:800 16px/1 'Chakra Petch',ui-monospace,monospace;color:#e6ecf7}
    .cb-scrap-lbl{font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;color:#9aa4b2}
    .cb-poster{width:120px;border-radius:12px;overflow:hidden;border:1px solid rgba(132,150,224,.4);animation:cbCardIn .5s cubic-bezier(.22,1.2,.36,1) .12s both}
    .cb-poster-sky{position:relative;height:60px}
    .cb-poster-disc{position:absolute;top:9px;left:50%;transform:translateX(-50%);width:24px;height:24px;border-radius:50%;box-shadow:0 0 12px currentColor}
    .cb-poster-grid{position:absolute;left:6px;right:6px;bottom:9px;height:1.5px;opacity:.9}
    .cb-poster-grid.low{bottom:4px;opacity:.55}
    .cb-poster-body{padding:7px 6px;text-align:center;background:rgba(10,7,22,.96)}
    .cb-poster-nm{font:800 13px/1.1 'Chakra Petch',ui-monospace,monospace;color:#fff}
    .cb-poster-tag{margin-top:3px;font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.12em;color:#7fbfff}
  `;
  document.head.appendChild(s);
}

export function createCrateBox(parent: HTMLElement, deps: CrateBoxDeps): CrateBox {
  injectStyles();
  const rng = deps.rng ?? clientRandom;

  const overlay = document.createElement("div");
  // ONE shop, TWO entrances (the lobby CRATES building and home's STORE tab), so this surface has to
  // paint above home (30) and the identity gate (30). At z-11 it sat UNDER home: the store entrance had
  // to blank home to be seen (baring the perps driving chrome behind the scrim), and any open fired
  // while home was up — the welcome crate — was drawn invisibly behind it. Stays below the access wall
  // (40) and driver-name / trade-history (42): those are hard gates and must keep covering the shop.
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:34", "display:none", "align-items:center", "justify-content:center",
    "padding:max(22px,env(safe-area-inset-top)) 18px", "background:rgba(0,0,0,.82)", "backdrop-filter:blur(2px)", "pointer-events:auto",
  ].join(";");

  const panel = document.createElement("div");
  panel.className = "panel cb-panel";
  const rowsHtml = CRATES.map((c) => `
    <div class="cb-col" style="--cc:${c.color}">
      <div class="cb-col-glow"></div><div class="cb-col-sheen"></div>
      <div class="cb-col-crate" data-ico="${c.key}"></div>
      <div class="cb-col-nm">${c.name.replace(" Crate", "")}</div>
      <div class="cb-col-odds">${oddsLine(c)}</div>
      <div class="cb-col-scrap">+${c.scrap} scrap</div>
      <div class="cb-col-buy">
        <button class="cb-coin" data-open="${c.key}">${c.priceCoins} ◈</button>
        ${c.priceSol ? `<button class="cb-sol" data-sol="${c.key}">${c.priceSol} SOL</button>` : ""}
      </div>
    </div>`).join("");
  panel.innerHTML =
    `<div class="cb-head"><span class="lbl">crate shop · devnet</span><span class="cb-coins">◈ <span data-cb="coins">0</span></span><button class="cb-x" data-cb="close" aria-label="Close">✕</button></div>` +
    `<div class="cb-cols" data-cb="rows">${rowsHtml}</div>`;
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  const q = (k: string) => panel.querySelector(`[data-cb="${k}"]`) as HTMLElement;
  const coinsEl = q("coins"), rows = q("rows");
  const revealCar = createRevealCar({ lowTier: deps.lowTier });
  let opening = false, giftMode = false; // giftMode: the free welcome open → its reveal "Done" closes to the strip
  let pendingSol: { crateKey: string; signature: string } | null = null;

  // Opening choreography (drop → shake → burst → card flip) is delegated to the shared cinematic —
  // the SAME module the marketing landing uses. It owns a full-screen fixed overlay (z-index 10000)
  // whose containing block is the viewport, so panel's overflow:hidden never clips it. We mount it
  // inside `panel` purely for lifecycle; the overlay carries its OWN click seam (see below), so its
  // buttons never depend on bubbling into panel. `onDone` is suppressed by hideDone, but routes
  // through the same finishReveal() as the Done button so it stays correct if ever surfaced.
  let run: CrateCinematicRun | null = null;
  const cinematic = createCrateCinematic({
    lowTier: deps.lowTier,
    onDone: () => finishReveal(),
  });
  panel.appendChild(cinematic.el);

  // ---- render the 3D crate GLBs to images once (transient renderer, disposed after) → used for the
  // shop icons + the opening animation. Mirrors the car-card render in carpicker.ts. ----
  const cratePng: Record<string, string> = {};
  let crates3dStarted = false;
  const renderCrates3d = () => {
    if (crates3dStarted) return;
    crates3dStarted = true;
    const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(2); r.setSize(220, 220, false);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    cam.position.set(2.1, 1.7, 2.5); cam.lookAt(0, -0.05, 0);
    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
    const loader = new GLTFLoader();
    const queue = CRATES.map((c) => c.key);
    const next = () => {
      const key = queue.shift();
      if (!key) { env.dispose(); r.dispose(); return; }
      loader.load(`/models/crate-${key}.glb`, (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(1 / (new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere()).radius || 1));
        const ctr = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
        model.position.set(-ctr.x, -ctr.y, -ctr.z);
        const scene = new THREE.Scene();
        scene.environment = env;
        scene.add(new THREE.AmbientLight("#8a78ff", 0.85));
        const kl = new THREE.DirectionalLight("#27e7ff", 1.7); kl.position.set(2.2, 3, 2.4); scene.add(kl);
        const rl = new THREE.DirectionalLight("#ff39c0", 1.5); rl.position.set(-2.4, 1.2, -2); scene.add(rl);
        const pivot = new THREE.Group(); pivot.rotation.y = -0.6; pivot.add(model); scene.add(pivot);
        toonify(model, { outlineWidth: 0.03 }); // cel-shade + outline the 3D crate (unit-sphere framed)
        r.render(scene, cam);
        cratePng[key] = r.domElement.toDataURL("image/png");
        const ico = panel.querySelector(`[data-ico="${key}"]`) as HTMLElement | null;
        if (ico) { ico.style.backgroundImage = `url(${cratePng[key]})`; ico.classList.add("has3d"); }
        model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); } });
        for (const mm of reclaimToonVariants(model)) mm.dispose(); // + the stashed off-style variants (also drops the crate from the style registry)
        next();
      }, undefined, (err) => { console.warn("[crate] GLB failed:", key, err); next(); });
    };
    next();
  };

  const syncCoins = () => {
    coinsEl.textContent = String(deps.coins());
    panel.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => {
      const c = CRATES.find((x) => x.key === b.dataset.open)!;
      b.disabled = deps.coins() < c.priceCoins;
    });
  };

  const showShop = () => {
    opening = false;
    run?.abort(); run = null; // tear down any live cinematic overlay so the shop is never left behind it
    rows.style.display = ""; // revert to the CSS grid (3 columns), not flex
    revealCar.clear();
    syncCoins();
  };

  // End the reveal the way today's Done does: a welcome (gift) open closes the whole crate UI back to
  // the strip; any other open returns to the shop. Shared by the cinematic onDone and the Done button.
  const finishReveal = () => { if (giftMode) { giftMode = false; close(); } else showShop(); };

  // Fill the cinematic's card face with the reward: the SAME halo/plate/loot markup the panel used to
  // render, re-targeted at the module `slot`. The Done / <crate> again buttons render INSIDE the slot
  // (not a panel bar) because the cinematic overlay covers the panel — placing them on the overlay is
  // the only way they stay visible AND clickable. Their `data-cb="done"` / `data-open` hooks are
  // handled by the overlay's own click seam (see handleControlClick). `.cb-reveal` gives the column
  // layout the reveal needs (the module slot is a centering flex box).
  const mountRevealContent = (slot: HTMLElement, crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null, vrf: boolean) => {
    opening = false;
    const t = tierOf(car.rarity);
    const lvl = lvlKey ? deps.levelInfo(lvlKey) : null;
    const bigBurst = t.id >= 4; // epic/legendary get a larger halo
    const again = deps.coins() >= crate.priceCoins;
    slot.innerHTML =
      `<div class="cb-reveal">` +
      `<div class="cb-halo${bigBurst ? " big" : ""}" style="--tc:${t.color}"></div>` +
      `<div class="cb-hero" data-cb="carslot"></div>` +
      `<div class="cb-plate">` +
        `<span class="cb-badge ${isNew ? "new" : "dupe"}">${isNew ? "NEW" : "DUPLICATE"}</span>` +
        `<div class="cb-tier" style="--tc:${t.color}">${t.name}</div>` +
        `<div class="cb-gems">${gems(t.id)}</div>` +
        `<div class="cb-name" style="--tc:${t.color}">${car.name}</div>` +
        (vrf ? `<span class="cb-vrf">⛓ MagicBlock VRF</span>` : "") +
      `</div>` +
      `<div class="cb-loot">` +
        scrapPileHtml(scrap) +
        (lvl ? levelPosterHtml(lvl) : "") +
      `</div>` +
      `<div class="cb-btns">` +
        `<button class="cb-btn ghost" data-cb="done">Done</button>` +
        (again ? `<button class="cb-btn" data-open="${crate.key}">${crate.name.split(" ")[0]} again · ${crate.priceCoins} ◈</button>` : "") +
      `</div>` +
      `</div>`;
    const carslot = slot.querySelector('[data-cb="carslot"]') as HTMLElement;
    carslot.appendChild(revealCar.el);
    revealCar.show({ url: car.url ?? "", scale: car.scale, yaw: car.yaw, tierColor: t.color });
  };

  // Hide the shop and hand the drop → shake choreography to the cinematic. `loop` keeps the crate
  // shaking (VRF/SOL paths wait on the oracle); otherwise a single settle → shake. A missing
  // cratePng[key] (3D not rendered yet) → the module falls back to its colored box, as before.
  const showCrateAnim = (crate: CrateType, loop: boolean) => {
    rows.style.display = "none"; // the reveal now lives entirely in the cinematic overlay above the panel
    run = cinematic.open({ crateImgUrl: cratePng[crate.key], crateColor: crate.color, loop });
  };
  // The burst → reveal handoff (shared): the cinematic runs the escalation/burst/flip, then fills its
  // card face via onCardSlot. Chips are suppressed (scrap/level/VRF already render inside the card, so
  // chips would only duplicate them); Done stays ours (hideDone) and renders inside the slot.
  const burstToReveal = (crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null, vrf: boolean) => {
    run?.reveal({
      rarity: car.rarity ?? 1,
      hideDone: true,
      onCardSlot: (slot) => mountRevealContent(slot, crate, car, isNew, scrap, lvlKey, vrf),
    });
  };
  // Map the resolved draws → car/scrap/level grants → reveal. false if nothing droppable (never happens
  // with the full roster, but keeps both paths honest about not charging for an empty pull).
  const resolveAndReveal = (crate: CrateType, draws: number[], vrf: boolean): boolean => {
    const car = rollCrate(deps.cars(), crate.tierWeights, draws[0], draws[1]);
    if (!car) return false; // nothing droppable
    const isNew = deps.grantCar(car.name);
    let scrap = crate.scrap;
    if (isNew) deps.unlockUI(car.name);
    else scrap += dupeScrap(car.rarity); // dupe adds a melt bonus on top of the crate scrap
    deps.addScrap(scrap);
    const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]); // additive level roll
    if (lvlKey) deps.grantLevel(lvlKey);
    burstToReveal(crate, car, isNew, scrap, lvlKey, vrf);
    return true;
  };

  const doOpen = (crate: CrateType, free = false, payment: "coins" | "sol" = "coins") => {
    if (opening) return;
    if (!free) giftMode = false; // a paid open ends the welcome flow → its reveal returns to the shop
    const vrfRequired = deps.vrfRequired?.() ?? false;
    const availableVrf = deps.vrfDraws?.() ?? null;
    const randomnessMode = crateRandomnessMode(vrfRequired, !!availableVrf);
    if (randomnessMode === "blocked") {
      deps.onVrfFail?.("Connect and fund your wallet to open this crate with MagicBlock VRF.");
      if (giftMode) { giftMode = false; close(); }
      return;
    }
    const vrfProvider = randomnessMode === "vrf" ? availableVrf : null;

    if (payment === "sol") {
      if (!crate.priceSol || !deps.buyWithSol) {
        deps.onVrfFail?.("SOL crate payments are temporarily unavailable.");
        return;
      }
      if (!vrfProvider || !vrfRequired) {
        deps.onVrfFail?.("Sign in with your wallet to buy crates with devnet SOL.");
        return;
      }
      if (pendingSol && pendingSol.crateKey !== crate.key) {
        const pendingName = crateByKey(pendingSol.crateKey).name;
        deps.onVrfFail?.(`Finish your paid ${pendingName} pull before buying another crate.`);
        return;
      }

      opening = true;
      giftMode = false;
      showCrateAnim(crate, true);
      void (async () => {
        if (!pendingSol) {
          const signature = await deps.buyWithSol!(crate.key, crate.priceSol!);
          pendingSol = { crateKey: crate.key, signature };
        }
        const draws = await vrfProvider(4);
        const revealed = resolveAndReveal(crate, draws, true);
        if (revealed) {
          pendingSol = null;
          return;
        }
        opening = false;
        showShop();
        deps.onVrfFail?.(`Your ${crate.name} payment is confirmed. Retry this pull without another charge.`);
      })().catch((error) => {
        opening = false;
        console.warn("[crate] SOL open failed:", error);
        if (pendingSol?.crateKey === crate.key) {
          deps.onVrfFail?.(`SOL payment confirmed. Retry your ${crate.name} pull without another charge.`);
        } else {
          deps.onVrfFail?.(solPaymentFailureMessage(error, crate.priceSol!));
        }
        showShop();
      });
      return;
    }

    if (!vrfProvider) {
      // ── guest / not connected: the existing sync client-RNG path, verbatim behavior ──
      if (!free && deps.coins() < crate.priceCoins) { syncCoins(); return; }
      const draws = [rng.next(), rng.next(), rng.next(), rng.next()];
      const car = rollCrate(deps.cars(), crate.tierWeights, draws[0], draws[1]);
      if (!car) { if (free) { giftMode = false; close(); } return; } // nothing droppable — never charge
      if (!free && !deps.spend(crate.priceCoins)) return;
      opening = true;
      syncCoins(); // reflect the debit in the shop header right away (rows are hidden during the reveal)
      showCrateAnim(crate, false);
      window.setTimeout(() => {
        // the sync draws already fixed the outcome — resolve grants + reveal (no chip on the guest path)
        const isNew = deps.grantCar(car.name);
        let scrap = crate.scrap;
        if (isNew) deps.unlockUI(car.name); else scrap += dupeScrap(car.rarity);
        deps.addScrap(scrap);
        const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]);
        if (lvlKey) deps.grantLevel(lvlKey);
        burstToReveal(crate, car, isNew, scrap, lvlKey, false);
      }, 500);
      return;
    }

    // ── signed-in: MagicBlock VRF. Debit FIRST (the mapping is public — randomness must never
    // be knowable before payment), request, shake while the oracle answers, fail closed. ──
    if (!free) {
      if (!deps.holdCoins || !deps.settleHold) { deps.onVrfFail?.("VRF wiring missing"); return; }
      if (!deps.holdCoins(crate.priceCoins)) { syncCoins(); return; }
    }
    opening = true;
    syncCoins();
    showCrateAnim(crate, true); // loop the shake while the oracle works
    void vrfProvider(4).then(async (draws) => {
      if (!free) deps.settleHold!(crate.priceCoins, true); // commit: forward the spend to the server
      const revealed = await completeVrfReward(
        free,
        deps.completeGift,
        () => resolveAndReveal(crate, draws, true),
      );
      if (!revealed) {
        opening = false;
        if (giftMode) { giftMode = false; close(); } else showShop();
      }
    }).catch((error) => {
      if (!free) deps.settleHold!(crate.priceCoins, false); // release: quiet local restore, zero server traffic
      opening = false;
      console.warn("[crate] verified open failed:", error);
      deps.onVrfFail?.(vrfFailureMessage(error, !free));
      if (giftMode) { giftMode = false; close(); } else showShop();
    });
  };

  // One control-click handler for both the shop panel and the cinematic overlay. The overlay gets its
  // OWN listener (not just panel bubbling) so its Done / again buttons keep working even if the overlay
  // is later mounted elsewhere (e.g. document.body). While it is still a panel descendant, its listener
  // stopPropagation()s so the shared handler never also fires via panel (no double-dispatch).
  const handleControlClick = (e: Event) => {
    const el = (e.target as HTMLElement).closest("[data-open],[data-sol],[data-cb]") as HTMLElement | null;
    if (!el) return;
    if (el.dataset.open) { const c = CRATES.find((x) => x.key === el.dataset.open); if (c) doOpen(c); return; }
    if (el.dataset.sol) { const c = CRATES.find((x) => x.key === el.dataset.sol); if (c) doOpen(c, false, "sol"); return; }
    const k = el.dataset.cb;
    if (k === "done") finishReveal();
    else if (k === "close") close();
  };
  panel.addEventListener("click", handleControlClick);
  cinematic.el.addEventListener("click", (e) => { e.stopPropagation(); handleControlClick(e); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") close(); });

  function close() {
    if (opening) return; // don't bail mid-open (the grant already happened)
    run?.abort(); run = null; // clear any reward overlay left up by the cinematic
    overlay.style.display = "none";
    revealCar.clear();
    deps.onClose?.();
  }

  return {
    open() { renderCrates3d(); showShop(); overlay.style.display = "flex"; },
    openGift(key) { renderCrates3d(); giftMode = true; overlay.style.display = "flex"; doOpen(crateByKey(key), true); },
    isOpen: () => overlay.style.display !== "none",
    setBusy(b) { if (b && !opening) { overlay.style.display = "none"; revealCar.clear(); } },
  };
}
