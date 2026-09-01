import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { tierOf } from "../core/rarity";
import {
  dupeScrap, pickLevel, clientRandom, CRATES, crateByKey, verifyCrateOpen,
  type CrateType, type CrateCar, type RandomnessProvider, type CrateRevealed,
} from "../core/crate";
import { currentChainRail, type ChainRail } from "../evm/rail";
import { PITY, emptyPity, hitTopTier, nextPity, rollCrateWithPity, type CrateKey, type PityState } from "../core/pity";
import { createRevealCar } from "./reveal-car";
import { scrapPileHtml, levelPosterHtml, type LevelPoster } from "./reveal-bits";
import { toonify, reclaimToonVariants } from "../render/toon";
import { createCrateCinematic } from "./crate-cinematic";

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
  pity?: () => PityState;
  recordPity?: (next: PityState) => void;
  /** signed-in verified open: server debits, rolls from VRF bytes, grants. */
  vrfRoll?: () => (null | (() => Promise<{ draws: number[]; bytesHex: string }>));
  openVerified?: (p: {
    crateKey: CrateKey;
    payment: "coins" | "sol" | "gift";
    /** EVM rail: the commit this open spends (from `crateCommit`). */
    commitId?: string;
    /** parked Solana rail: MagicBlock VRF bytes. */
    vrfBytes?: string;
    solSignature?: string;
  }) => Promise<VerifiedCrateOpen>;
  applyVerified?: (result: VerifiedCrateOpen) => void;
  /**
   * Which chain rail this build talks to. EVM = server commit-reveal crates; "solana" keeps the
   * parked MagicBlock-VRF path alive. Injectable so tests can pin either rail.
   */
  rail?: () => ChainRail;
  /**
   * EVM rail: reserve server randomness BEFORE the open. The returned commitment is shown to the
   * player while the crate shakes, and the open's reveal must hash back to it.
   */
  crateCommit?: () => Promise<{ commitId: string; commitment: string }>;
}

export interface VerifiedCrateOpen {
  carId: string;
  isNew: boolean;
  count: number;
  scrap: number;
  scrapTotal: number;
  coins: number;
  levelKey: string | null;
  pity: PityState;
  /** commit-reveal only: the seed+nonce behind the commitment published before this open. */
  reveal?: CrateRevealed | null;
  /** the draws the server rolled from, re-derived here from the revealed seed. */
  draws?: number[] | null;
}

/** How a reveal advertises where its randomness came from. */
export type CrateProofBadge = { kind: "vrf" } | { kind: "proven"; commitment: string };
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

/**
 * EVM rail: an account-backed crate MUST come from a server commit-reveal — it can never fall back
 * to browser randomness, because the server is the one debiting and granting. A guest has no account
 * to charge, so it practices locally.
 */
export function provenRandomnessMode(accountBacked: boolean, canProve: boolean): CrateRandomnessMode {
  if (!accountBacked) return "client";
  return canProve ? "vrf" : "blocked";
}

/** What the player is told when a reveal fails to prove itself. Never phrased as a success. */
export function proofFailureMessage(reason: "missing_reveal" | "commitment_mismatch" | "draws_mismatch"): string {
  if (reason === "missing_reveal") return "This open returned no proof, so it could not be verified.";
  if (reason === "draws_mismatch") return "The revealed seed does not produce this result.";
  return "The revealed seed does not match the published commitment.";
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
    @keyframes cbBurst{0%{transform:scale(1);opacity:1}100%{transform:scale(1.9);opacity:0}}
    @keyframes cbFlash{0%{opacity:0}30%{opacity:.95}100%{opacity:0}}
    @keyframes cbCardIn{0%{transform:translateY(20px) scale(.6) rotateY(85deg);opacity:0}60%{transform:translateY(0) scale(1.05) rotateY(0);opacity:1}100%{transform:scale(1)}}
    @keyframes cbScrapIn{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}
    @keyframes cbGlow{0%,100%{opacity:.55}50%{opacity:.95}}
    @keyframes cbShake{10%,90%{transform:translate3d(-1px,0,0)}30%,50%,70%{transform:translate3d(-4px,0,0) rotate(-3deg)}40%,60%{transform:translate3d(4px,0,0) rotate(3deg)}}
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
    .cb-col-pity{font:700 9px/1.2 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;color:#9aa4b2;text-transform:uppercase}
    .cb-col-od{display:inline-flex;align-items:center;gap:3px;font:700 9px/1 'Chakra Petch',ui-monospace,monospace;color:rgba(226,230,255,.82)}
    .cb-col-od i{width:6px;height:6px;border-radius:50%;background:var(--tc);box-shadow:0 0 5px var(--tc);flex:none}
    .cb-col-scrap{font:700 11px/1 'Chakra Petch',ui-monospace,monospace;color:#c2cad6}
    .cb-col-buy{position:relative;display:flex;flex-direction:column;gap:5px;width:100%;margin-top:auto}
    .cb-coin{border:0;border-radius:9px;padding:9px 4px;cursor:pointer;font:800 12px/1 'Chakra Petch',ui-monospace,monospace;white-space:nowrap;width:100%;
      color:#04130d;background:linear-gradient(180deg,#48f0b6,#14c78c);box-shadow:0 3px 10px rgba(46,230,166,.32)}
    .cb-coin:disabled{cursor:not-allowed;color:var(--mut);background:rgba(255,255,255,.08);box-shadow:none}
    .cb-sol{border:1px solid rgba(255,209,102,.4);border-radius:9px;padding:7px 4px;cursor:pointer;font:800 11px/1 'Chakra Petch',ui-monospace,monospace;width:100%;
      color:var(--amb);background:rgba(255,209,102,.1)}
    /* reveal */
    .cb-stage{display:none;flex-direction:column;align-items:center;gap:14px;padding:6px 0 2px;position:relative;min-height:230px;justify-content:center}
    .cb-stage.on{display:flex}
    .cb-crate{width:96px;height:84px;border-radius:11px;position:relative;background:linear-gradient(160deg,color-mix(in srgb,var(--cc) 55%,#1a1330),#150e28);
      border:2px solid var(--cc);box-shadow:0 0 22px color-mix(in srgb,var(--cc) 50%,transparent)}
    .cb-crate::after{content:"";position:absolute;left:0;right:0;top:50%;height:12px;transform:translateY(-50%);background:var(--cc);opacity:.9}
    .cb-crate.shake{animation:cbShake .5s cubic-bezier(.36,.07,.19,.97) both}
    .cb-crate.gone{animation:cbBurst .3s ease-out forwards}
    .cb-crate3d{width:124px;height:112px;object-fit:contain;filter:drop-shadow(0 0 20px var(--cc,#fff))}
    .cb-crate3d.shake{animation:cbShake .5s cubic-bezier(.36,.07,.19,.97) both}
    .cb-crate3d.gone{animation:cbBurst .3s ease-out forwards}
    .cb-crate3d.shakeloop,.cb-crate.shakeloop{animation:cbShake .5s cubic-bezier(.36,.07,.19,.97) infinite}
    .cb-vrf{display:inline-flex;align-items:center;gap:5px;margin-top:7px;padding:4px 9px;border-radius:6px;
      font:700 9px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.08em;color:#a7f0d9;
      background:rgba(20,199,140,.12);border:1px solid rgba(20,199,140,.4)}
    .cb-commit{margin-top:10px;max-width:88%;text-align:center;font:700 9px/1.5 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;color:#8f9bb3;word-break:break-all}
    .cb-commit b{display:block;letter-spacing:.14em;color:#a7f0d9;text-transform:uppercase}
    .cb-proof{margin-top:5px;font:700 8px/1.4 'Chakra Petch',ui-monospace,monospace;letter-spacing:.06em;color:#7d879b;word-break:break-all;max-width:200px;text-align:center}
    .cb-fail{display:flex;flex-direction:column;align-items:center;gap:9px;padding:18px;border-radius:14px;text-align:center;
      border:2px solid #ff5c7a;background:rgba(40,10,22,.92);box-shadow:0 0 24px rgba(255,92,122,.35)}
    .cb-fail-ttl{font:800 15px/1 'Chakra Petch',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#ff8098}
    .cb-fail-msg{font:700 11px/1.5 'Chakra Petch',ui-monospace,monospace;color:#e6ecf7;max-width:260px}
    .cb-flash{position:absolute;top:20px;width:200px;height:200px;background:radial-gradient(circle,#fff,transparent 62%);opacity:0;pointer-events:none}
    .cb-flash.go{animation:cbFlash .5s ease-out}
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
  const railOf = (): ChainRail => deps.rail?.() ?? currentChainRail();

  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:11", "display:none", "align-items:center", "justify-content:center",
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
      <div class="cb-col-pity" data-pity="${c.key}"></div>
      <div class="cb-col-scrap">+${c.scrap} scrap</div>
      <div class="cb-col-buy">
        <button class="cb-coin" data-open="${c.key}">${c.priceCoins} ◈</button>
        ${c.priceSol ? `<button class="cb-sol" data-sol="${c.key}">${c.priceSol} SOL</button>` : ""}
      </div>
    </div>`).join("");
  panel.innerHTML =
    `<div class="cb-head"><span class="lbl" data-cb="shop-lbl">crate shop · practice</span><span class="cb-coins">◈ <span data-cb="coins">0</span></span><button class="cb-x" data-cb="close" aria-label="Close">✕</button></div>` +
    `<div class="cb-cols" data-cb="rows">${rowsHtml}</div>` +
    `<div class="cb-stage" data-cb="stage"></div>` +
    `<div class="cb-btns" data-cb="btns" style="display:none"></div>`;
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  const q = (k: string) => panel.querySelector(`[data-cb="${k}"]`) as HTMLElement;
  const coinsEl = q("coins"), rows = q("rows"), stage = q("stage"), btns = q("btns");
  const cinematic = createCrateCinematic(stage);
  const revealCar = createRevealCar({ lowTier: deps.lowTier });
  let opening = false, giftMode = false; // giftMode: the free welcome open → its reveal "Done" closes to the strip
  let pendingSol: { crateKey: string; signature: string } | null = null;

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

  const syncPity = () => {
    const state = deps.pity?.() ?? emptyPity();
    panel.querySelectorAll<HTMLElement>("[data-pity]").forEach((el) => {
      const key = el.dataset.pity as CrateKey;
      const rule = PITY[key];
      el.textContent = `Pity ${state[key]}/${rule.hard} → ${tierOf(rule.topTier).name}`;
    });
  };

  const bumpPity = (key: CrateKey, car: CrateCar | null) => {
    const state = { ...(deps.pity?.() ?? emptyPity()) };
    state[key] = nextPity(key, state[key], hitTopTier(car, key));
    deps.recordPity?.(state);
  };

  const syncCoins = () => {
    coinsEl.textContent = String(deps.coins());
    panel.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => {
      const c = CRATES.find((x) => x.key === b.dataset.open)!;
      b.disabled = deps.coins() < c.priceCoins;
    });
    syncPity();
    const lbl = panel.querySelector("[data-cb=shop-lbl]");
    if (lbl) lbl.textContent = deps.vrfRequired?.() ? "crate shop · vrf" : "crate shop · practice";
  };
  syncCoins();

  const showShop = () => {
    opening = false;
    rows.style.display = ""; // revert to the CSS grid (3 columns), not flex
    stage.classList.remove("on"); stage.innerHTML = "";
    revealCar.clear();
    btns.style.display = "none"; btns.innerHTML = "";
    syncCoins();
  };

  // The provenance line under the car name: the parked VRF badge, or the commit-reveal proof with
  // the commitment the server published BEFORE this open (the thing that makes it checkable).
  const proofHtml = (proof: CrateProofBadge | null): string => {
    if (!proof) return "";
    if (proof.kind === "vrf") return `<span class="cb-vrf">⛓ MagicBlock VRF</span>`;
    return `<span class="cb-vrf" data-cb="proof-badge">✓ provably fair</span>` +
      `<div class="cb-proof" data-cb="proof" data-commitment="${proof.commitment}">commit ${proof.commitment.slice(0, 16)}…</div>`;
  };

  const showReveal = (crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null, proof: CrateProofBadge | null) => {
    opening = false;
    const t = tierOf(car.rarity);
    const lvl = lvlKey ? deps.levelInfo(lvlKey) : null;
    const bigBurst = t.id >= 4; // epic/legendary get a larger halo
    stage.innerHTML =
      `<div class="cb-halo${bigBurst ? " big" : ""}" style="--tc:${t.color}"></div>` +
      `<div class="cb-hero" data-cb="carslot"></div>` +
      `<div class="cb-plate">` +
        `<span class="cb-badge ${isNew ? "new" : "dupe"}">${isNew ? "NEW" : "DUPLICATE"}</span>` +
        `<div class="cb-tier" style="--tc:${t.color}">${t.name}</div>` +
        `<div class="cb-gems">${gems(t.id)}</div>` +
        `<div class="cb-name" style="--tc:${t.color}">${car.name}</div>` +
        proofHtml(proof) +
      `</div>` +
      `<div class="cb-loot">` +
        scrapPileHtml(scrap) +
        (lvl ? levelPosterHtml(lvl) : "") +
      `</div>`;
    stage.classList.add("on");
    const slot = stage.querySelector('[data-cb="carslot"]') as HTMLElement;
    slot.appendChild(revealCar.el);
    revealCar.show({ url: car.url ?? "", scale: car.scale, yaw: car.yaw, tierColor: t.color });
    const again = deps.coins() >= crate.priceCoins;
    btns.style.display = "flex";
    btns.innerHTML =
      `<button class="cb-btn ghost" data-cb="done">Done</button>` +
      (again ? `<button class="cb-btn" data-open="${crate.key}">${crate.name.split(" ")[0]} again · ${crate.priceCoins} ◈</button>` : "");
  };

  // The crate-shaking cosmetic (shared by both paths): hide the shop rows, drop the crate art in.
  // `loop` = keep shaking (VRF path waits on the oracle); otherwise a single 500ms shake.
  const showCrateAnim = (crate: CrateType, loop: boolean) => {
    rows.style.display = "none";
    btns.style.display = "none"; btns.innerHTML = "";
    stage.innerHTML = (cratePng[crate.key]
      ? `<img class="cb-crate3d ${loop ? "shakeloop" : "shake"}" src="${cratePng[crate.key]}" style="--cc:${crate.color}">`
      : `<div class="cb-crate ${loop ? "shakeloop" : "shake"}" style="--cc:${crate.color}"></div>`) + `<div class="cb-flash"></div>`;
    stage.classList.add("on");
  };
  // Publish the server's commitment WHILE the crate shakes — before the outcome is known. Showing it
  // only afterwards would prove nothing, since the player could not tell it was picked in advance.
  const showCommitment = (commitment: string) => {
    const line = document.createElement("div");
    line.className = "cb-commit";
    line.dataset.cb = "commit";
    line.dataset.commitment = commitment;
    line.innerHTML = `<b>server commitment</b>${commitment}`;
    stage.appendChild(line);
  };

  // A reveal that does not hash back to the published commitment is NEVER shown as a win.
  const showVerificationFailed = (message: string) => {
    opening = false;
    revealCar.clear();
    rows.style.display = "none";
    stage.innerHTML =
      `<div class="cb-fail" data-cb="verify-failed">` +
        `<div class="cb-fail-ttl">verification failed</div>` +
        `<div class="cb-fail-msg">${message}</div>` +
      `</div>`;
    stage.classList.add("on");
    btns.style.display = "flex";
    btns.innerHTML = `<button class="cb-btn ghost" data-cb="done">Done</button>`;
  };

  // The burst → reveal handoff (shared): stop the shake, flash, then swap to the reward card.
  const burstToReveal = (crate: CrateType, car: CrateCar, isNew: boolean, scrap: number, lvlKey: string | null, proof: CrateProofBadge | null) => {
    const crateEl = stage.querySelector(".cb-crate3d, .cb-crate") as HTMLElement;
    const flash = stage.querySelector(".cb-flash") as HTMLElement;
    if (tierOf(car.rarity).id >= 4) flash.style.transform = "scale(1.5)";
    crateEl.classList.remove("shake", "shakeloop"); crateEl.classList.add("gone");
    flash.classList.add("go");
    window.setTimeout(() => showReveal(crate, car, isNew, scrap, lvlKey, proof), 230);
  };
  // Map the resolved draws → car/scrap/level grants → reveal. false if nothing droppable (never happens
  // with the full roster, but keeps both paths honest about not charging for an empty pull).
  const resolveAndReveal = (crate: CrateType, draws: number[], proof: CrateProofBadge | null): boolean => {
    const misses = (deps.pity?.() ?? emptyPity())[crate.key];
    const car = rollCrateWithPity(deps.cars(), crate.key, crate.tierWeights, misses, draws[0], draws[1]);
    if (!car) return false; // nothing droppable
    const isNew = deps.grantCar(car.name);
    let scrap = crate.scrap;
    if (isNew) deps.unlockUI(car.name);
    else scrap += dupeScrap(car.rarity); // dupe adds a melt bonus on top of the crate scrap
    deps.addScrap(scrap);
    const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]); // additive level roll
    if (lvlKey) deps.grantLevel(lvlKey);
    bumpPity(crate.key, car);
    burstToReveal(crate, car, isNew, scrap, lvlKey, proof);
    return true;
  };

  // ── guest / not connected: client RNG + local pity (practice). No account is charged, so nothing
  // here needs proving; a signed-in open never reaches this path on either rail. ──
  const openPractice = (crate: CrateType, free: boolean): void => {
    if (!free && deps.coins() < crate.priceCoins) { syncCoins(); return; }
    const draws = [rng.next(), rng.next(), rng.next(), rng.next()];
    const misses = (deps.pity?.() ?? emptyPity())[crate.key];
    const car = rollCrateWithPity(deps.cars(), crate.key, crate.tierWeights, misses, draws[0], draws[1]);
    if (!car) { if (free) { giftMode = false; close(); } return; } // nothing droppable — never charge
    if (!free && !deps.spend(crate.priceCoins)) return;
    opening = true;
    syncCoins();
    rows.style.display = "none";
    stage.classList.add("on");
    void cinematic.play({
      color: crate.color,
      rarity: car.rarity ?? 1,
      cratePng: cratePng[crate.key],
    }).then(() => {
      const isNew = deps.grantCar(car.name);
      let scrap = crate.scrap;
      if (isNew) deps.unlockUI(car.name); else scrap += dupeScrap(car.rarity);
      deps.addScrap(scrap);
      const lvlKey = pickLevel(deps.lockedLevels(), crate.levelChance, draws[2], draws[3]);
      if (lvlKey) deps.grantLevel(lvlKey);
      bumpPity(crate.key, car);
      showReveal(crate, car, isNew, scrap, lvlKey, null);
    });
  };

  // ── EVM rail: server commit-reveal. The server publishes sha256(seed‖nonce) BEFORE it knows which
  // crate is being opened, then debits, rolls, grants, and reveals the seed. Nothing is applied here
  // until the reveal hashes back to that commitment AND re-derives the draws the outcome used. ──
  const openProven = (crate: CrateType, free: boolean, payment: "coins" | "sol"): void => {
    if (payment === "sol") {
      // devnet SOL purchases are Solana-rail plumbing; they are parked with that rail.
      deps.onVrfFail?.("SOL crate payments are temporarily unavailable.");
      return;
    }
    const accountBacked = deps.vrfRequired?.() ?? false;
    const mode = provenRandomnessMode(accountBacked, !!(deps.crateCommit && deps.openVerified));
    if (mode === "client") { openPractice(crate, free); return; }
    if (mode === "blocked") {
      deps.onVrfFail?.("Provably fair crates are unavailable right now. Try again shortly.");
      if (giftMode) { giftMode = false; close(); }
      return;
    }

    opening = true;
    syncCoins();
    showCrateAnim(crate, true); // loop the shake while the server commits + rolls
    void (async () => {
      const { commitId, commitment } = await deps.crateCommit!();
      showCommitment(commitment); // published while the outcome is still unknown
      const result = await deps.openVerified!({
        crateKey: crate.key,
        payment: free ? "gift" : "coins",
        commitId,
      });
      if (free) {
        const claimed = await completeVrfReward(true, deps.completeGift, () => true);
        if (!claimed) throw new Error("welcome_already_claimed");
      }
      const proof = verifyCrateOpen({ commitment, reveal: result.reveal, draws: result.draws });
      if (!proof.ok) {
        // The server already granted this server-side, but an unproven roll is never shown as a win
        // and never written into local state — the player is told the check failed.
        console.warn("[crate] proof failed:", proof.reason, commitment);
        deps.onVrfFail?.(proofFailureMessage(proof.reason));
        showVerificationFailed(proofFailureMessage(proof.reason));
        return;
      }
      deps.applyVerified?.(result);
      deps.recordPity?.(result.pity);
      const car = deps.cars().find((c) => c.name === result.carId);
      if (!car) throw new Error("crate_car_missing");
      showReveal(crate, car, result.isNew, result.scrap, result.levelKey, { kind: "proven", commitment });
    })().catch((error) => {
      opening = false;
      console.warn("[crate] proven open failed:", error);
      // no client-side escrow on this path (the server debits), so never claim coins were restored
      deps.onVrfFail?.(vrfFailureMessage(error, false));
      if (giftMode) { giftMode = false; close(); } else showShop();
    });
  };

  const doOpen = (crate: CrateType, free = false, payment: "coins" | "sol" = "coins") => {
    if (opening) return;
    if (!free) giftMode = false; // a paid open ends the welcome flow → its reveal returns to the shop
    if (railOf() === "evm") { openProven(crate, free, payment); return; }
    // ── parked Solana rail: MagicBlock VRF ──
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
        const roller = deps.vrfRoll?.();
        if (deps.openVerified && roller) {
          const { bytesHex } = await roller();
          const result = await deps.openVerified({
            crateKey: crate.key, payment: "sol", vrfBytes: bytesHex, solSignature: pendingSol.signature,
          });
          deps.applyVerified?.(result);
          deps.recordPity?.(result.pity);
          const car = deps.cars().find((c) => c.name === result.carId);
          if (car) {
            pendingSol = null;
            showReveal(crate, car, result.isNew, result.scrap, result.levelKey, { kind: "vrf" });
            return;
          }
        } else {
          const draws = await vrfProvider(4);
          const revealed = resolveAndReveal(crate, draws, { kind: "vrf" });
          if (revealed) {
            pendingSol = null;
            return;
          }
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

    if (!vrfProvider) { openPractice(crate, free); return; }

    // ── signed-in: MagicBlock VRF. Debit FIRST (the mapping is public — randomness must never
    // be knowable before payment), request, shake while the oracle answers, fail closed. ──
    const roller = deps.vrfRoll?.();
    if (deps.openVerified && roller) {
      opening = true;
      syncCoins();
      showCrateAnim(crate, true);
      void (async () => {
        const { bytesHex } = await roller();
        const result = await deps.openVerified!({
          crateKey: crate.key,
          payment: free ? "gift" : "coins",
          vrfBytes: bytesHex,
        });
        if (free) {
          const claimed = await completeVrfReward(true, deps.completeGift, () => true);
          if (!claimed) throw new Error("welcome_already_claimed");
        }
        deps.applyVerified?.(result);
        deps.recordPity?.(result.pity);
        const car = deps.cars().find((c) => c.name === result.carId);
        if (!car) throw new Error("crate_car_missing");
        showReveal(crate, car, result.isNew, result.scrap, result.levelKey, { kind: "vrf" });
      })().catch((error) => {
        opening = false;
        console.warn("[crate] verified open failed:", error);
        deps.onVrfFail?.(vrfFailureMessage(error, !free));
        if (giftMode) { giftMode = false; close(); } else showShop();
      });
      return;
    }
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
        () => resolveAndReveal(crate, draws, { kind: "vrf" }),
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

  panel.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest("[data-open],[data-sol],[data-cb]") as HTMLElement | null;
    if (!el) return;
    if (el.dataset.open) { const c = CRATES.find((x) => x.key === el.dataset.open); if (c) doOpen(c); return; }
    if (el.dataset.sol) { const c = CRATES.find((x) => x.key === el.dataset.sol); if (c) doOpen(c, false, "sol"); return; }
    const k = el.dataset.cb;
    if (k === "done") { if (giftMode) { giftMode = false; close(); } else showShop(); }
    else if (k === "close") close();
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display !== "none") close(); });

  function close() {
    if (opening) return; // don't bail mid-open (the grant already happened)
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
