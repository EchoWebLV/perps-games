import { Buffer } from "buffer";
// @ts-ignore assign the browser global some Solana deps read at runtime
globalThis.Buffer = globalThis.Buffer || Buffer;
import * as THREE from "three";
import { createScene } from "./render/scene";
import { createWorld } from "./render/world";
import { installOutlineDevControls, refreshToonStyle, isToonEnabled, setToonEnabled, onToonChanged, getOutlineWidth, setOutlineWidth, getWorldRampBand, setWorldRampBand } from "./render/toon";
import { edgePassEnabled, setEdgePassEnabled } from "./render/edge-outline-pass";
import { registerLightLab } from "./ui/light-lab";
import { pNum } from "./config/visual-presets";
import { THEMES, themeKeys, nextThemeKey, loadThemeKey } from "./render/world-themes";
import { createCar } from "./render/car";
import { createChaseCam, ROAD_SPEED_MAX, roadSpeed } from "./render/camera";
import { detectQuality, gpuRendererString, shouldRenderFrame } from "./platform/perf";
import { createPost } from "./render/post";
import { createHud } from "./ui/hud";
import { createTach } from "./ui/tach";
import { createControls, DEFAULT_PLAY_CAP } from "./ui/controls";
import { createHighwayControls } from "./ui/highway-controls";
import { connectFeed } from "./core/feed";
import { createBootReveal } from "./core/boot-reveal";
import { createPriceSource } from "./core/price-source";
import { RoundEngine } from "./core/round";
import type { Snapshot } from "./core/types";
import { sol3 } from "./core/money";
import { ACTIVE_STAKE_CURRENCY, baseToUnits, unitsToBase } from "./core/stake-currency";
import { applyConfirmedWalletSpend } from "./core/wallet-balance-model";
import { clampInt } from "./core/round-sync";
import { niceLev, tToLev } from "./core/leverage";
import { liqPriceOf } from "./core/economics";
import { reconcileFlip } from "./core/flip-reconcile";
import { createUpgrades } from "./ui/upgrades";
import { CONFIG } from "./core/config";
import { carLeverageCeiling } from "@perps/engine/entitlements";
import { createMinimap } from "./ui/minimap";
import { CART_COIN_RATE, createPickups } from "./render/pickups";
import { createFireTrail } from "./render/firetrail";
import { createCarPicker, type CarAbility, type CarOption, type Garage } from "./ui/carpicker";
import { createCrateBox } from "./ui/cratebox";
import { createHome } from "./ui/home";
import { createHowTo, howToSeen, markHowToSeen } from "./ui/howto";
import { createTradeHistory } from "./ui/trade-history";
import { createInventory } from "./core/inventory";
import { createSessionAuth } from "./core/auth-session";
import { ApiError, createApi } from "./core/api";
import { showLocalEconomyMenu } from "./core/menu-visibility";
import { createTradeHistoryRecorder } from "./core/trade-history-recorder";
import { createTradeHistoryBridge } from "./core/trade-history-live";
import { createAccountSync, type AccountSnapshot } from "./core/account-sync";
import { accountSignInTransition, browserStore } from "./core/identity";
import { createPresenceClient, type PresenceClient, type PresencePlayer, type PresenceHighway } from "./core/presence";
import { routePresenceEmote } from "./core/presence-emote-route";
import { presenceHudShouldShow, presenceShouldConnect } from "./core/presence-lifecycle";
import { bindAndHydrate } from "./core/sign-in-sync";
import { poolable } from "./core/rarity";
import { createFx } from "./ui/fx";
import { createDeathsDoor } from "./ui/deaths-door";
import { createAutoExit } from "./ui/pinkrod";
import { createJoystick } from "./ui/joystick";
import { createAudio } from "./core/audio";
import { createRadio } from "./ui/radio";
import { readVolume, writeVolume, MUSIC_VOL_KEY, SFX_VOL_KEY } from "./core/audio-prefs";
import { createCoinCounter } from "./ui/coins";
import { createScrapCounter } from "./ui/scrap";
import { createFpsMeter } from "./ui/fpsmeter";
import { createNitro } from "./ui/nitro";
import { createFlux, FLUX_LEV } from "./ui/flux";
import { createMagnet } from "./ui/magnet";
import { createBarrelRoll } from "./ui/barrelroll";
import { createWorldFlipCore } from "./core/worldflip";
import { jackpotRoll } from "./core/slots";
import { createWallet } from "./ui/wallet";
import { createLobby } from "./render/lobby";
import { createEmoteVisualResources, updateEmoteVisual } from "./render/emote-visual";
import { createLobbyCam } from "./render/lobbycam";
import { createStripCars, lightestSpecs } from "./render/stripcars";
import { createStripBillboard } from "./render/billboard";
import { createCruisers } from "./render/cruisers";
import { clearIdentity, createIdentityGate, loadIdentity, saveIdentity, type Identity } from "./ui/identity";
import { createDriverNameDialog } from "./ui/driver-name";
import { createPresenceHud } from "./ui/presence";
import { createAccessWall } from "./ui/access-wall";
import { anyAccountRedeemed, anyRedeemed, redeem, redeemForAccount, type RedeemPorts } from "./core/access-code";
import { offerPendingAccountWelcome, shouldGrantWelcome, welcomeClaimed, markWelcome } from "./core/welcome";
import { GUEST_SAVE_NAMESPACE, readSaveSnapshot, restoreSave, stashSave, wipeSave } from "./core/save-vault";
import { createLobbyHud } from "./ui/lobbyhud";
import { step as driveStep, DRIVE, type DriveState, type DriveTune } from "./core/freedrive";
import { stepBody, type BodyState } from "./core/body-language";
import { laneStep, type LaneState } from "./core/lane-drive";
import { entranceHit, LOT_BOUNDS, LOBBY_SPAWN, doorExitPose, type BuildingKind } from "./core/lobby-layout";
import { modeSwitchBlocked } from "./core/mode-guard";
import { createOval } from "./render/oval";
import { createGarageRoom } from "./render/garage-room";
import { createRaceGame, mulberry32, type RaceGame } from "./render/race-mode";
import { createChainBookSource } from "./render/race-book-source";
import { DEFAULT_STAKE } from "./ui/bet-panel";
import { buildGrid } from "./core/race-grid";
import { elevationAt } from "./core/track";
import { HIGHWAY_MAX_LEV, highwayPose, seedHighwayMotion, speedForLeverage, stepHighwayMotion, synchronizedHighwayMotion, type HighwayMotion } from "./core/highway-auto";
import { PublicKey } from "@solana/web3.js";
import { CHAIN } from "./chain/config";
import { createGameSession } from "./chain/game-session";
import { HIGHWAY_DURATION_SENTINEL, isHighwayRound, roundKey, type RoundSnap } from "./chain/chain-round";
import { selectChainWalletPort } from "./chain/wallet-select";
import { createCrateRollDraws, makeCrateRollIo } from "./chain/crate-roll";
import { payDevnetSol } from "./chain/sol-payment";
import { createPaddockBook, LiveStakesError, type PaddockBook } from "./chain/paddock";
import { betableOf, createPaddockStaging, type PaddockStaging } from "./chain/paddock-staging";
import {
  createHighwayRoundReader,
  deriveHighwayRoundPda,
  selectRemoteHighwayPlayers,
  verifyHighwayPresence,
} from "./chain/highway-verifier";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;
const CRATE_TREASURY = (import.meta.env.VITE_CRATE_TREASURY_PUBKEY as string | undefined) ?? "";

const ctx = createScene(canvas);
// Boot milestones (30/55/75/90) reported to the splash bar. They still all fire within a single
// synchronous module eval, so the bar eases straight to 90 — deferring the world/lobby/oval/garage
// behind ensureWorlds() REMOVED sync work from boot (home now shows sooner) but added no async gap,
// so the beats don't visibly step. The car GLB (async) is the only real gap, and home owns the hide.
(window as Window & { setSplashProgress?: (pct: number) => void }).setSplashProgress?.(30); // boot milestone: scene up

// quality / post-processing (perf-gated) — the GPU string catches weak GPUs behind strong
// CPUs (Seeker: 8GB/8-core but Mali-G615); ?perf=low|high overrides for on-device tuning
const gpu = gpuRendererString(ctx.renderer.getContext());
const quality = detectQuality({ gpuRenderer: gpu, search: location.search });
console.log(`Perps Rider quality: ${quality.tier} · bloom ${quality.bloom ? "×" + quality.bloomScale : "off"} · msaa ${quality.postSamples}× · dpr≤${quality.pixelRatioCap} · ${quality.frameCapFps ? quality.frameCapFps + "fps cap" : "uncapped"} · ${quality.detail}${gpu ? ` (${gpu})` : ""}`);
ctx.renderer.setPixelRatio(Math.min(quality.pixelRatioCap, window.devicePixelRatio || 1));
const post = quality.bloom ? createPost(ctx.renderer, ctx.scene, ctx.camera, quality.bloomScale, quality.postSamples) : null;
// Keep the renderer + bloom composer matched to the live viewport. Relying on the window
// "resize" event ALONE is fragile on a cold start: on a first visit (uncached) or in the app
// WebView the viewport can settle to its final size AFTER this module runs without ever firing
// "resize", leaving the scene rendered at the boot-time size — a plausible cause of the "bloom/
// lights look wrong on first load" reports. A ResizeObserver on the canvas also catches that
// initial settle. setSize(…, false) never touches the CSS box, so this can't feedback-loop.
function applyViewportSize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (w === 0 || h === 0) return; // a 0×0 viewport (cold start / hidden tab / pre-layout WebView)
  // would size the buffers to nothing and give the camera a NaN aspect — skip; a later fire corrects.
  ctx.resize(w, h);
  post?.setSize(w, h);
}
addEventListener("resize", applyViewportSize);
// ResizeObserver also fires on the initial 0→real settle that a window "resize" event misses —
// so a scene first built at a 0×0/stale viewport gets re-sized the moment the canvas lays out.
if (typeof ResizeObserver !== "undefined") new ResizeObserver(applyViewportSize).observe(canvas);

// world + car — the race world (and the lobby/oval/garage below) is DEFERRED behind ensureWorlds():
// the game boots straight to the 2D home with NO 3D world built. `let … | null`, assigned inside
// ensureWorlds() on the first entry into any 3D mode. See ensureWorlds() near the mode functions.
let world: ReturnType<typeof createWorld> | null = null;
installOutlineDevControls(); // DEV: [ / ] rescale every cel-shade outline live; window.__outline(x) — world-independent, stays eager
// Boot art-style sync: sets the `toon-ui` body class (the comic race-hud/bet-panel skin that
// grandprix-entered-straight-from-home relies on) and toons any eager roots. ensureWorlds() calls
// refreshToonStyle() AGAIN once the world's toon'd/variant roots exist. The HUD chip toggles it live.
refreshToonStyle();
/** swap the race-world skin AND re-warm its brand-new shader programs off the hot path —
 *  setTheme rebuilds env/lamp materials, and compiling them from a menu beats a first-corner
 *  stall on the next track entry (precompileModes is defined below, hoisted). */
function setWorldTheme(key: string): string {
  if (!world) return loadThemeKey(); // skin picker / __skin fired before the first 3D entry — the persisted key is exactly what a fresh world would boot with
  world.setTheme(key);
  requestAnimationFrame(() => precompileModes());
  return world.currentTheme();
}
// dev/test switcher for race-level skins — the crate-reward system will call world.setTheme() later.
//   __skin.list() · __skin.set('volcano') · __skin.next() · __skin.current()
(window as any).__skin = {
  list: () => themeKeys(),
  set: (key: string) => setWorldTheme(key),
  next: () => setWorldTheme(nextThemeKey(world?.currentTheme() ?? loadThemeKey())),
  current: () => world?.currentTheme() ?? loadThemeKey(),
};
// Home now owns the splash hide (enterHome calls hideSplash — "home-ready IS boot-ready"), so the
// car-GLB settle no longer dismisses the splash. The bounded 20s fallback stays wired (belt-and-
// suspenders: if boot wedged before enterHome, the timeout still frees a trapped player).
const bootReveal = createBootReveal({
  timeoutMs: 20_000,
  reveal: () => (window as Window & { hideSplash?: () => void }).hideSplash?.(), // fallback only; enterHome is the normal path
});
const car = createCar((outcome) => bootReveal.modelSettled(outcome));
const localEmoteResources = createEmoteVisualResources();
const localEmoteVisual = localEmoteResources.make();
car.group.add(localEmoteVisual.object);
car.group.position.set(0, 0, -12);
// YXZ everywhere: yaw first, then pitch/roll about the car's OWN axes — under the default
// XYZ a pitched car leans sideways at yaw≠0 (the lobby bug de1760d fixed). Every mode
// entry re-asserts it; the racer pose is multi-axis too since the lane-drive rebuild (7H).
car.group.rotation.order = "YXZ";
ctx.scene.add(car.group);
const chase = createChaseCam();
const pickups = createPickups();
ctx.scene.add(pickups.group);
const fireTrail = createFireTrail(); // DeLorean flux: burning tire traces while the freeze is on
ctx.scene.add(fireTrail.group);

// core
const engine = new RoundEngine();
// ── on-chain round (Slice 4) ────────────────────────────────────────────────
// The round loop + SOL play balance run on-chain via the dev-keypair port. The local engine
// still drives the smooth visual ×; the on-chain Round is the only money truth.
// The play ledger is denominated in CENTI-SOL units (1 unit = 0.01 SOL). With 9-decimal
// wSOL this maps a unit to 10^7 lamports — the same ×100 scale the old cents model used.
const BUY_IN_BASE = ACTIVE_STAKE_CURRENCY.initialBuyInBase;
let roundActive = false; // a round is open locally (de-dupes finalizeSettled across crank/poll/close)
let simRound = false;    // guest practice round: engine-only, no wallet, no chain — free to try
let settling = false;    // a close tx is in flight
let nearDeath = false;   // Skull "Death's Door" danger latch (hysteresis so it doesn't flicker)
let opening = false;     // the GO handler (ensureSession+open) is mid-flight
const session = createGameSession({
  mint: new PublicKey(CHAIN.STAKE_MINT),
  onSettled: (info) => finalizeSettled(info), // terminal-first background lever
  port: selectChainWalletPort(), // Privy by default (app id set); ?wallet=dev forces the dev keypair
});
// The paddock book rides the SAME signer as everything else on chain — session.anchorWallet()
// is the documented seam for that (crate-roll VRF already uses it). Lazy and keyed by address:
// loginFresh can change the wallet, and the old account's staging must not leak into the new one.
let paddockPair: { client: PaddockBook; staging: PaddockStaging; address: string } | null = null;
function paddockFor(): { client: PaddockBook; staging: PaddockStaging } | null {
  const w = session.anchorWallet();
  if (!w) return null;
  const address = w.publicKey.toBase58();
  if (paddockPair?.address !== address) {
    paddockPair?.staging.dispose();
    const client = createPaddockBook({ wallet: w, mint: CHAIN.PADDOCK_BOOK_MINT });
    paddockPair = { client, staging: createPaddockStaging({ client }), address };
  }
  return paddockPair;
}
// Money staged in the race seat, in the same centi-SOL units as the play balance. The wallet
// panel's Cash Out gate reads playCents + bookCents: a Watch-&-bet-only player never pressed GO,
// so their whole balance lives HERE and a perps-only gate would lock them out of it. Last-known
// by design — the panel's sync status() cannot await a chain read, so this is refreshed at the
// three moments it can actually change: a race build, a cash-out, and opening the panel.
let bookCents = 0;
/** Re-read the seat away from the frame loop, then re-render the panel. `reuse` (the pair is
 *  delegated) is the only state whose truth lives in the ER — betableOf then counts a past
 *  race's claimable winnings, which cash_out collects too, and leaves out stakes riding the
 *  LIVE race, which it cannot. Otherwise the money is home on L1 and the Bettor ledger is the
 *  number. Read failures keep the last-known figure: a stale number that lets the player try
 *  beats a zero that disables their way out. */
async function refreshBookCents(): Promise<void> {
  const pad = paddockFor();
  if (!pad) return;
  try {
    const state = await pad.client.delegationState();
    let base: bigint;
    if (state === "reuse") {
      const [race, bettor] = await Promise.all([pad.client.raceSnapshot(), pad.client.bettorSnapshot()]);
      base = betableOf(race, bettor);
    } else {
      base = await pad.client.bettorL1Balance();
    }
    bookCents = baseToUnits(base);
    renderKnownBalance(); // re-runs the panel's gate + its race-book line
  } catch { /* keep the last-known figure */ }
}
// The cash chip + wallet hero show the player's TOTAL money — wallet SOL + play balance —
// one number, the way the player thinks about it ("I sent 5 SOL, I have 5 SOL"). Moving
// money between wallet and play (buy-in / cash-out) barely moves it; wins and losses do.
// Display-only: money logic reads `session.balance()` (base units) directly.
let walletSolUnits = 0; // last-read wallet SOL (centi-SOL units)
let walletSolRequest = 0;
function renderKnownBalance() {
  const play = baseToUnits(session.balance());
  balance = play + walletSolUnits;
  hud.setBalance(balance);
  walletUI.setBalance(balance);
}
function reconcileWalletSol() {
  const request = ++walletSolRequest;
  // Reconcile silently after event-driven updates. Read the current play balance again when the
  // RPC resolves so a slow wallet response cannot restore a stale pre-settlement snapshot.
  void session.walletSol().then((sol) => {
    if (request !== walletSolRequest) return;
    walletSolUnits = baseToUnits(sol);
    renderKnownBalance();
  }).catch(() => {});
}
function syncOnchainBalance() {
  // Guests have no wallet — the chip reads "practice" and never renders SOL numbers.
  if (identity?.mode === "guest") { hud.setTryMode(true); return; }
  hud.setTryMode(false);
  // Render cached chain state immediately, then reconcile the wallet side in the background.
  renderKnownBalance();
  reconcileWalletSol();
}
// The game is fully on-chain: the SOL play balance + round loop live in `session` (the ER round).
// `balance` is the displayed cash chip, sourced only from the on-chain play balance (centi-SOL units).
let balance = 0;

// Identity is deliberately nullable during the first lobby entry. The game scene boots before
// the returning rider is loaded or a new rider is chosen, so presence must remain offline until
// one of those identity paths completes.
let identity: Identity | null = null;
let accountDriverName: string | null = null;

// Lazy sign-in — there is NO login gate. The game boots straight into the scene; the wallet
// connects on the FIRST money action (GO or the wallet panel). Under Privy that's the moment
// the login modal opens, so "press GO → log in → you're racing" is the whole onboarding.
let signedIn = false, signingIn = false;
// The identity gate can't see WHY a sign-in failed (ensureSignedIn swallows into `false`),
// and the HUD status it does set is hidden behind the modal — so the last failure's short
// message is kept here for the gate to display. Cleared on success.
let lastSignInError = "";
// `fresh` = account-chooser semantics (the identity gate's SIGN IN): any lingering wallet
// session is dropped first so the login UI ALWAYS shows and a different account can be
// picked. Default (resume) semantics are for re-auth of the player we already know —
// boot reconnect, GO, the wallet chip — where silently continuing the session is right.
async function ensureSignedIn(fresh = false): Promise<boolean> {
  if (signedIn && !fresh) return true;
  if (signingIn) return false; // a login attempt (modal) is already up — don't stack another
  signingIn = true;
  try {
    if (fresh) {
      signedIn = false; // the old session is going away even if the new login fails
      accountDriverName = null;
      accountSync.disable();
      await session.loginFresh();
    } else {
      await session.init();
    }
    syncOnchainBalance();
    // A prior account logout may have checkpointed progress locally before wallet binding existed.
    // Offer only THIS wallet's stash to Railway; a non-empty server account still wins in hydrate().
    const accountStash = fresh ? readSaveSnapshot(session.address()) : null;
    await syncAccount(fresh, accountStash ?? undefined);
    signedIn = true;
    lastSignInError = "";
    restoreHighwayPosition();
    void syncTableCap(); // clamp the bet stepper to the live table limit right away
    return true;
  } catch (e) {
    console.error("sign-in failed", e);
    const msg = String((e as Error)?.message ?? e);
    lastSignInError = msg;
    hud.setStatus(
      msg.includes("privy_login_cancelled") ? "Sign-in cancelled — press GO to try again." :
      msg.includes("privy_unreachable") ? "Couldn't reach sign-in — check your connection and try again." :
      "Sign-in failed — check your connection and try again.");
    return false;
  } finally {
    signingIn = false;
  }
}

// Bind the Privy identity to the server and pull coins/scrap/cars. Offline/failure → the game keeps
// running on the local cache; the next successful sign-in reconciles (server wins).
//
// A first account bind must not migrate the starter state rendered before identity selection. A
// guest-to-account bind also must not migrate the guest's coins/cars. Only the real guest save swap
// reloads the page; a fresh visitor keeps the already-warmed scene and continues in place.
let zeroLocalSnapshotForSignIn = false;
async function syncAccount(required = false, snapshotOverride?: AccountSnapshot): Promise<void> {
  try {
    const port = {
      connect: async () => ({ address: session.address() }),
      signMessage: (m: Uint8Array) => session.signMessage(m),
    };
    await bindAndHydrate({
      api, auth, port, accountSync,
      localSnapshot: snapshotOverride ?? (zeroLocalSnapshotForSignIn
        ? { coins: 0, scrap: 0, cars: {}, levels: { turbo: 0, tank: 0, suspension: 0 } }
        : { coins: upgrades.coins(), scrap: upgrades.scrap(), cars: inventory.snapshot(), levels: upgrades.levels() }),
      requireServerHydration: required,
    });
    const serverDriverName = accountSync.driverName();
    accountDriverName = serverDriverName;
    if (serverDriverName && identity?.mode === "privy" && identity.name !== serverDriverName) {
      identity = { ...identity, name: serverDriverName };
      saveIdentity(identity);
      reconnectPresenceForIdentity();
    }
    void tradeHistoryBridge.flush();
  } catch (e) {
    console.error("account sync failed", e); // cache-only until next sign-in
    if (required) throw e;
  }
}

// price feeds — BTC / ETH / SOL (subscribe to all; the active one drives the game)
const ASSETS = [
  { key: "BTC", lz: 1, hx: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8 },
  { key: "ETH", lz: 2, hx: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", expo: -8 },
  { key: "SOL", lz: 6, hx: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8 },
];
let asset: "BTC" | "ETH" | "SOL" = "SOL"; // the active tab; open() binds the round to this asset's registered Lazer feed
const latestAssetPrices = new Map<"BTC" | "ETH" | "SOL", number>();
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: ASSETS, onPrice: (k, v) => {
      const key = k as "BTC" | "ETH" | "SOL";
      if (v > 0) latestAssetPrices.set(key, v);
      if (key === asset) onPrice(v);
    } });
    return () => h.stop();
  },
});
addEventListener("pagehide", () => priceSource.stop());
// bfcache restore: pagehide stop()'d the feed, but the last real tick can still be recent enough
// that live() would lie true on a frozen price — a money GO could then open on it. Re-subscribe
// and force not-live until a fresh tick lands. (Only persisted/bfcache restores need this; a normal
// load re-creates the source, and a tab-switch never stops it, so visibilitychange isn't involved.)
addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) priceSource.restart(); });

// ui
const hud = createHud(hudRoot, ACTIVE_STAKE_CURRENCY);
const tach = createTach(hud.tachMount);
const controls = createControls(hud.ctrlMount, hud.goMount, hud.pedalMount);
const highwayControls = createHighwayControls(hud.highwayMount, {
  onCommit: (lev) => {
    if (engine.getPhase() !== "live") {
      highwayConfirmedLev = lev;
      game.lev = lev;
      highwayControls.setConfirmed(lev);
      return;
    }
    engine.setLeverage(lev, priceSource.price(), Date.now());
    game.lev = lev;
    if (simRound) {
      highwayConfirmedLev = lev;
      highwayControls.setConfirmed(lev);
    } else {
      highwayControls.setSyncing(lev);
      session.noteLeverage(lev);
    }
  },
});
const minimap = createMinimap(hud.miniCanvas, quality.pixelRatioCap);
(window as Window & { setSplashProgress?: (pct: number) => void }).setSplashProgress?.(55); // boot milestone: HUD up
const fx = createFx();
const deathsDoor = createDeathsDoor(); // Skull car: near-death sequence at the liq floor
const worldFlip = createWorldFlipCore(); // Helmet spectacle: the level barrel-rolls on the flip
// Pink Rod's Auto-Exit (stop-loss / take-profit) panel — appended into the pre-round control
// stack AFTER createControls set its innerHTML; values are stamped on-chain at GO.
const autoExit = createAutoExit(hud.ctrlMount);
const joystick = createJoystick();
// On the dev server (localhost), boot muted so the game is quiet by default; the
// shipped build still starts with music + SFX on. Either can be flipped back on
// from the menu (Music / SFX).
const AUDIO_DEFAULT_ON = !import.meta.env.DEV;
// Persisted fader positions (0..1). A fresh player boots at the shipped default — full on prod,
// muted on the dev server — and their last-set volumes are restored on reload.
const sfxVol0 = readVolume(SFX_VOL_KEY, AUDIO_DEFAULT_ON ? 1 : 0);
const musicVol0 = readVolume(MUSIC_VOL_KEY, AUDIO_DEFAULT_ON ? 1 : 0);
const audio = createAudio(sfxVol0);
const coins = createCoinCounter(hudRoot);
const scrap = createScrapCounter(hudRoot); // banks scrap caught while driving (every 3rd–5th pickup)
const fpsMeter = createFpsMeter(hudRoot); // ?fps diagnostic chip for on-device perf tuning — inert without the flag
// Orion's Nitro Overdrive — 2× leverage burst; the button fires it, main applies the boost
const nitro = createNitro(hudRoot, () => { fx.nitro(); chase.shake(0.7); navigator.vibrate?.([0, 30, 20, 40]); });
// DeLorean's Flux Brake — bank the P&L + pin leverage to 10× for ~4s; the lever rebank IS
// the freeze (provable on-chain). Engage on the tap itself — don't wait a frame — then the
// loop holds the pin while active and hands back to the throttle when the window ends.
const flux = createFlux(hudRoot, () => {
  game.lev = FLUX_LEV;
  engine.setLeverage(FLUX_LEV, priceSource.price()); // local rebank: gains lock into banked now
  if (!simRound) session.noteLeverage(FLUX_LEV);     // on-chain lever follows (coalesced; practice stays local)
  chase.shake(0.35); navigator.vibrate?.(25);
});
// Magnet's "Coin Magnet" — chargeable coin-vacuum burst (was always-on). The button fires
// it; the loop feeds the returned flag to pickups.setMagnet so coins curve in for ~4s.
const magnet = createMagnet(hudRoot, () => { chase.shake(0.35); navigator.vibrate?.(25); });
// Helmet's "Barrel Roll" — a manual, once-per-round move (replaces the old auto-swerve-
// on-dying): tap to reverse the trade AND barrel-roll the whole world. The on-chain flip
// mirrors in the background (terminal-first, so a doomed flip still settles honestly).
const barrelRoll = createBarrelRoll(hudRoot, () => {
  if (!roundActive || settling || flipping) return; // the button is live-only, but stay safe
  const px = priceSource.price();
  const nd = (round.dir === 1 ? -1 : 1) as 1 | -1;
  engine.setDir(nd, px);          // instant local flip (feel)
  round.dir = nd;
  round.entryPx = px;             // re-anchor the local liq line to the flip mark
  controls.setDir(nd);
  worldFlip.trigger();            // the bet inverted → barrel-roll the level
  void doFlip(nd);                // mirror to the on-chain round in the background
  hud.setStatus(`🪖 Barrel roll! Now ${nd === 1 ? "LONG" : "SHORT"}.`);
  chase.shake(0.6); navigator.vibrate?.([0, 30, 40, 30]);
});
hud.setBalance(balance);
// Effective leverage ceiling = the car's starting ceiling plus every earned Turbo step.
// Cybertruck starts at 1500, so Turbo level 1 raises it immediately to 1550.
let carBaseLev = 0;
let ability: CarAbility | undefined;
// Six Wheeler "Heavy Load": hauls more, revs slower — 0.25 SOL max bet, +50% round time, half
// the tach ceiling. Pure client trade: `open` passes the longer dur (the program clamps it
// ≤180s) and the lower ceiling only caps what leverage the throttle can reach.
const HEAVY_PLAY_CAP = 25, HEAVY_DUR = 1.5, HEAVY_LEV = 0.5;
const effRmax = (upgradedRmax = CONFIG.RMAX) => Math.round(
  carLeverageCeiling(upgradedRmax, carBaseLev) * (ability === "sixWheeler" ? HEAVY_LEV : 1),
);
const effMaxSec = () => Math.round(CONFIG.MAXSEC * (ability === "sixWheeler" ? HEAVY_DUR : 1));
// Server account: coins/scrap/cars live on @perps/server keyed by the Privy identity. The auth
// provider holds the wallet-bound session token; `api` talks to the server; `accountSync` reconciles
// on sign-in and forwards best-effort deltas. Guests never enable it (all forwarders no-op).
const auth = createSessionAuth();
const api = createApi({ auth });
const tradeRecorder = createTradeHistoryRecorder({
  api,
  wallet: () => session.address(),
});
const tradeHistoryBridge = createTradeHistoryBridge(tradeRecorder);
const tradeHistory = createTradeHistory(hudRoot, {
  currency: ACTIVE_STAKE_CURRENCY,
  signedIn: () => identity?.mode === "privy" && signedIn,
  flush: () => tradeHistoryBridge.flush(),
  load: (cursor) => api.listTrades(cursor),
});
const capacitorNative = (globalThis as {
  Capacitor?: { isNativePlatform?: () => boolean };
}).Capacitor?.isNativePlatform?.() === true;
const showGarageAndUpgrades = showLocalEconomyMenu({
  dev: import.meta.env.DEV,
  hostname: globalThis.location?.hostname ?? "",
  native: capacitorNative,
});
let garageForHydration: Garage | null = null;
const accountSync = createAccountSync({
  api,
  nonce: String(Date.now()), // stable per page load; namespaces this session's delta refs
  applyServer: (snap) => {
    upgrades.hydrate({ coins: snap.coins, scrap: snap.scrap, levels: snap.levels });
    inventory.hydrate(snap.cars);
    garageForHydration?.reconcileOwnership((name) => inventory.owns(name));
  },
});

async function persistDriverName(name: string): Promise<void> {
  if (!identity) throw new Error("driver_identity_missing");

  let savedName = name;
  if (identity.mode === "privy") {
    if (!signedIn && !(await ensureSignedIn())) throw new Error("driver_sign_in_failed");
    const saved = await api.setDriverName(name);
    savedName = saved.driverName;
    accountDriverName = savedName;
  }

  identity = { ...identity, name: savedName };
  saveIdentity(identity);
  reconnectPresenceForIdentity();
}

let driverNameDialog: ReturnType<typeof createDriverNameDialog> | null = null;
function openDriverNameDialog(requiredForHighway: boolean, afterSave?: () => void): void {
  if (!identity) { showIdentityGate(); return; }
  driverNameDialog?.close();
  driverNameDialog = createDriverNameDialog(hudRoot, {
    currentName: identity.name,
    requiredForHighway,
    onSave: async (name) => {
      await persistDriverName(name);
      driverNameDialog = null;
      afterSave?.();
    },
    onCancel: () => { driverNameDialog = null; },
  });
}
// persistent coin balance + the upgrade tree; buying spends coins. Turbo Kit (max leverage) and
// Long-Range Tank (round time) apply live now that the on-chain program honors both.
const upgrades = createUpgrades(hudRoot, {
  onCoins: (n) => coins.set(n),
  onScrap: (n) => scrap.set(n),
  onApply: () => tach.rebuild(effRmax()),
  leverageValue: (upgradedRmax) => effRmax(upgradedRmax),
  economicEffects: true,
  onClose: () => { if (mode === "lobby") lobbyHud.show(); }, // returning to the lobby town → restore the back button
  onMutate: (ev) => {
    if (ev.kind === "coinsEarn") accountSync.coinsEarned(ev.amount);
    else if (ev.kind === "coinsSpend") accountSync.coinsSpent(ev.amount);
    else if (ev.kind === "scrapEarn") accountSync.scrapEarned(ev.amount);
    else if (ev.kind === "scrapSpend") accountSync.scrapSpent(ev.amount);
    else if (ev.kind === "levelBought") accountSync.levelBought(ev.track); // the server buy debits itself — no coinsSpent
  },
});
coins.set(upgrades.coins(), false); // no pulse on the persisted balance at load
scrap.set(upgrades.scrap(), false);

// The race seat's cash-out steps, in the player's language — the same vocabulary the bet panel
// uses for the identical chain steps (bet-panel's STEP_LABEL), minus its top-up framing: here the
// seat is being emptied, not refilled. Anything unmapped leaves the last line standing.
const CASH_OUT_STATUS: Record<string, string> = {
  claim: "Collecting your last win",
  exit: "Freeing your seat",
  undelegate: "Waiting for the rollup to hand it back",
  withdraw: "Gathering your balance",
  unwrap: "Unwrapping to SOL",
};
// wallet page (opened by tapping the balance chip) — shows the player's deposit QR.
const walletUI = createWallet(hudRoot, {
  currency: ACTIVE_STAKE_CURRENCY,
  // the wallet shown for funding is the on-chain session wallet (Privy embedded / dev keypair)
  address: () => session.address(),
  balance: () => balance,
  // the wallet's own SOL (lamports → SOL), so a deposit visibly arrives before the first GO
  fetchWalletSol: async () => { try { return Number(await session.walletSol()) / 10 ** ACTIVE_STAKE_CURRENCY.decimals; } catch { return null; } },
  onchain: {
    // playCents stays PERPS-ONLY — it feeds the "in play" figure under the hero. The race seat is
    // its own number beside it; only the Cash Out gate adds the two.
    status: () => ({ delegated: session.delegated(), playCents: baseToUnits(session.balance()), bookCents }),
    // One player action. "Cash out" quietly undelegates the ER session (if one is live) and THEN
    // withdraws to the wallet — the player never sees the delegate/undelegate lifecycle, they just
    // move their balance to their wallet in a single tap.
    cashOut: async () => {
      hud.setStatus("Cashing out…");
      if (session.delegated()) await session.endSession(); // undelegate under the hood
      await session.withdraw();
      // The race book comes home through the same door — one Cash Out returns ALL the money (the
      // player never sees the seat lifecycle). Through the STAGING CONTROLLER, never the client
      // directly: it owns the single-flight slot the background refill uses (two sequences must
      // not drive the same PDAs), and it parks the boomerang — after a successful cash-out the
      // frame loop would otherwise re-stage the money we just withdrew.
      let deferred = false;
      const pad = paddockFor();
      if (pad) {
        // The undelegate leg alone polls the L1 owner for up to ~80s. Narrate the controller's own
        // step so that stretch reads as work in progress instead of a dead button.
        const narrate = setInterval(() => {
          const label = CASH_OUT_STATUS[pad.staging.status().step ?? ""];
          if (label) hud.setStatus(label);
        }, 500);
        try {
          await pad.staging.cashOutNow();
          bookCents = 0; // the seat is empty; the panel's gate + line follow the sync below
        } catch (e) {
          // A seat riding the LIVE race cannot exit yet. That is normal play, not a failure: the
          // stakes settle with the race and the money comes home on the next Cash Out.
          if (!(e instanceof LiveStakesError)) throw e;
          deferred = true;
        } finally {
          clearInterval(narrate);
        }
      }
      // After the paddock leg, so the figure the player is left looking at includes everything
      // that actually moved.
      syncOnchainBalance();
      if (deferred) { hud.setStatus("Race still running — your race-book balance comes home after it settles."); return; }
      hud.setStatus("Cashed out to your wallet."); // only when BOTH legs are clean
    },
  },
  // Log out moved to the menu (settings); the wallet page is deposit-only now.
});
hud.onWallet(() => {
  if (engine.getPhase() === "live") return;
  // guests have no wallet page — the practice chip is the sign-in upsell
  if (!identity || identity.mode === "guest") { showIdentityGate(); return; }
  // funding needs an address, so the wallet chip signs you in first (Privy modal if needed)
  void ensureSignedIn().then((ok) => {
    if (!ok) return;
    walletUI.open();
    // The panel paints from the last-known seat figure immediately; this re-reads it and re-renders
    // the moment the chain answers, so a player who bet in a previous session still sees the money
    // (and the enabled button) without having entered a race first.
    void refreshBookCents();
  });
});

// car picker — swap the GLB model live + apply the card's special ability
const setAbility = (a?: CarAbility) => {
  ability = a;
  world?.setLaneBet(a === "laneBet");     // Clown Car colors the road green/red — no-op before ensureWorlds(); enterLobby re-applies via setAbility(ability)
  controls.setLaneMode(a === "laneBet");  // keep LONG/SHORT visible as a live readout
  nitro.setEnabled(a === "nitro");        // Orion shows the Nitro Overdrive button
  flux.setEnabled(a === "flux");          // DeLorean shows the Flux Brake button
  pickups.setRainbow(a === "rainbow");    // Vaporwave: rainbow coins + value multipliers
  pickups.setCoinRate(a === "cartRod" ? CART_COIN_RATE : 1); // Cart Rod: +33% coins on the road
  magnet.setEnabled(a === "magnet");      // Magnet: chargeable coin-vacuum button (the loop drives pickups.setMagnet)
  deathsDoor.setEnabled(a === "skull");   // Skull: near-death sequence when equity hits the floor
  barrelRoll.setEnabled(a === "swerve");  // Helmet: manual once-per-round flip + world barrel roll
  autoExit.setEnabled(a === "pinkRod");   // Pink Rod: pre-round stop-loss / take-profit sliders
  abilityPlayCap = a === "sixWheeler" ? HEAVY_PLAY_CAP : DEFAULT_PLAY_CAP; // Six Wheeler hauls a bigger max bet
  syncPlayCap();
};

// The bet stepper must never offer a stake the house can't pay — bankroll state is the
// INPUT's constraint, not a GO error (project rule: the player never sees house plumbing).
// Effective cap = min(car ability cap, what the pot + this session's till can host); the
// 1-unit floor keeps the stepper alive so the truly-broke-house backstop can still be named.
let abilityPlayCap = DEFAULT_PLAY_CAP;
let tablePlayCap = Infinity; // 0.01-SOL units; Infinity until the first successful read
function syncPlayCap() {
  controls.setPlayCap(Math.max(1, Math.min(abilityPlayCap, Number.isFinite(tablePlayCap) ? tablePlayCap : abilityPlayCap)));
}
let capSyncing = false;
async function syncTableCap() {
  if (capSyncing) return;
  capSyncing = true;
  try {
    const lim = await session.tableLimit(); // null = unknown (not connected / RPC blip): keep the last cap
    if (lim !== null) { tablePlayCap = Number(lim / BigInt(unitsToBase(1))); syncPlayCap(); }
  } finally { capSyncing = false; }
}
// keep the cap honest while the player sits on the bet screen (other tables carve the same
// pot); the stepper is locked during a live round, so skip the read noise there
setInterval(() => { if (signedIn && !roundActive && !opening) void syncTableCap(); }, 12_000);
// synthwave radio — streams on the first gesture; its on/off toggle lives in the menu (below)
const radio = createRadio(hudRoot, musicVol0);
const inventory = createInventory("redline.owned.v1", ["Solana Paper"], localStorage, {
  onGrant: (id) => accountSync.carGranted(id),
  onMelt: (id) => accountSync.carMelted(id),
}); // Solana Paper is free; other cars pull from crates
// level/world skins: the booted theme is owned; the rest unlock from crates (this gates the World picker below).
// world isn't built yet (deferred behind ensureWorlds), but world.currentTheme() would be getTheme(loadThemeKey()).key,
// which === loadThemeKey() (a resolved key round-trips through getTheme unchanged) — and createWorld itself boots via
// setTheme(loadThemeKey()). So loadThemeKey() is the identical seed, preserving the booted-theme-is-owned invariant.
const levels = createInventory("redline.levels.v1", [loadThemeKey()]);
const themeOf = (k: string) => THEMES.find((t) => t.key === k) ?? THEMES[0];
const CAR_DEFS: CarOption[] = [
  { name: "DeLorean", rarity: 4, url: "/models/delorean.glb", ability: "flux", power: { name: "Flux Brake", desc: "freeze your P&L ~4s", icon: "clock" } },
  { name: "Cybertruck", rarity: 3, url: "/models/cybertruck.glb", scale: 1.3, baseLev: 1500, power: { name: "Overclocked", desc: "starts at 1500× leverage", icon: "gauge" } },
  { name: "Orion", rarity: 5, url: "/models/orion.glb", scale: 1.2, yaw: -Math.PI / 2, ability: "nitro", power: { name: "Nitro Overdrive", desc: "2× leverage · 3s", icon: "flame" } },
  { name: "Vaporwave", rarity: 3, url: "/models/vaporwave.glb", ability: "rainbow", power: { name: "Rainbow Coins", desc: "×2 ×3 ×5 coin drops", icon: "sparkle" } },
  { name: "Bedrock", rarity: 5, url: "/models/flintstone.glb", scale: 0.7, ability: "airbag", power: { name: "Stone-Age Airbag", desc: "up to 20% back on a wreck", icon: "chute" } },
  { name: "Clown Car", rarity: 5, url: "/models/clown-car.glb", yaw: Math.PI / 2, ability: "laneBet", power: { name: "Lane Bet", desc: "steer = LONG / SHORT", icon: "swap" } },
  // headline new cars — abilities still to be designed (brainstorming car-by-car).
  // skull/slot-machine are different model sources; yaw is a guess (+π/2) — fix if a card faces backwards.
  { name: "Skull", rarity: 5, pool: false, url: "/models/skull.glb", yaw: Math.PI / 2, ability: "skull", power: { name: "Death's Door", desc: "survive a liq for 2s", icon: "skull" }, comingSoon: true },
  { name: "Slot Machine", rarity: 4, pool: false, comingSoon: true, url: "/models/slot-machine.glb", yaw: Math.PI / 2, ability: "slots", power: { name: "Triple 7s", desc: "1-in-50 rounds: +777 coins", icon: "bell" } },
  // descriptive-renamed placeholders (were Car 5–8 / Default) — same pack, length-on-X → yaw +π/2.
  { name: "Cart Rod", rarity: 3, url: "/models/shopping-cart.glb", scale: 0.65, yaw: Math.PI / 2, ability: "cartRod", power: { name: "Coin Scoop", desc: "+33% coins on the road", icon: "coin" } },
  { name: "Magnet", rarity: 3, url: "/models/magnet.glb", scale: 0.75, yaw: Math.PI / 2, ability: "magnet", power: { name: "Coin Magnet", desc: "tap: vacuum coins · 4s", icon: "magnet" } },
  { name: "Helmet", rarity: 4, url: "/models/helmet.glb", yaw: Math.PI / 2, ability: "swerve", power: { name: "Barrel Roll", desc: "flip your bet + the whole world", icon: "swerve" } },
  { name: "Pink Rod", rarity: 4, url: "/models/pink-rod.glb", yaw: Math.PI / 2, ability: "pinkRod", power: { name: "Auto-Exit", desc: "set a stop-loss / take-profit", icon: "target" } },
  { name: "Six Wheeler", rarity: 4, url: "/models/six-wheeler.glb", yaw: Math.PI / 2, ability: "sixWheeler", power: { name: "Heavy Load", desc: "bigger bets · more time · slower ×", icon: "weight" } },
  // COMMON tier (rarity 1, one gem) — pure novelty. NO `ability` → drives stock, zero perp edge;
  // the "power" line is flavor-only (rarity buys prestige, never an edge). Descriptions are jokes.
  // +π/2 turns these length-on-X models to face DOWN the road (nose forward) — drive-test confirmed on all;
  // the RV is length-on-Z (yaw 0), just scaled up because it read small. (GLBs compressed 2026-07-06.)
  { name: "Banana", url: "/models/banana.glb", rarity: 1, yaw: Math.PI / 2, power: { name: "Peel Out", desc: "100% real potassium", icon: "flame" } },
  // BENCHED 2026-07-08 (user verdict: "not fun at all to drive"): pool:false drops it from crate
  // pulls, comingSoon:true taps it off the pickable rotation. Its GLB, card art, and any already-
  // owned copies stay intact — an owner just sees a COMING SOON card they can't equip.
  { name: "Cook Wagon", url: "/models/breaking_rv.glb", rarity: 1, scale: 1.7, pool: false, comingSoon: true, power: { name: "Cooking", desc: "99.1% pure horsepower", icon: "flame" } },
  { name: "Solana Paper", displayName: "Trabant", url: "/models/trabant.glb", rarity: 1, pool: false, yaw: Math.PI / 2, power: { name: "Two-Stroke", desc: "0–60, eventually", icon: "clock" } },
  { name: "Big Frank", url: "/models/wiener.glb", rarity: 1, yaw: Math.PI / 2, power: { name: "Relish It", desc: "ketchup sold separately", icon: "flame" } },
  { name: "Dragon", url: "/models/dragon.glb", rarity: 1, yaw: Math.PI / 2, power: { name: "Fire Breather", desc: "runs on spicy noodles", icon: "flame" } },
  { name: "Homewrecker", url: "/models/house.glb", rarity: 1, yaw: Math.PI / 2, power: { name: "Full House", desc: "mortgage not included", icon: "weight" } },
  { name: "Copycat", url: "/models/cat.glb", rarity: 3, yaw: Math.PI / 2, power: { name: "Furball", desc: "coughs up hairballs", icon: "flame" } },
  { name: "Knockout", url: "/models/knockout.glb", rarity: 3, yaw: Math.PI / 2, power: { name: "All Show", desc: "flames don't add horsepower", icon: "flame" } },
  // UNCOMMON (2) — flamboyant new set (cactus/kraken/ramen). Power lines are flavor-only until the
  // minor leverage/time abilities are built. Single-mesh blobs (no wheels), compressed ~15–23MB.
  { name: "Prickle", url: "/models/cactus.glb", rarity: 2, yaw: Math.PI / 2, power: { name: "Prickly", desc: "do not hug the driver", icon: "flame" } },
  { name: "The Kraken", url: "/models/kraken.glb", rarity: 2, yaw: Math.PI / 2, power: { name: "Deep Six", desc: "smells faintly of low tide", icon: "swerve" } },
  { name: "Noodler", url: "/models/ramen.glb", rarity: 2, yaw: Math.PI / 2, power: { name: "Al Dente", desc: "served scalding, tips poorly", icon: "flame" } },
];
// DEV-only local unlock: on the Vite dev server AND a loopback host, skip the hard access wall and open
// all content (every car + every level theme) for style/level testing. import.meta.env.DEV is false in
// every production build, so this whole branch is dead (and tree-shaken) in prod → production behaviour
// is byte-identical (gate + unlock ladder stay). Client-side only; never touches the server.
const DEV_UNLOCK = !!import.meta.env.DEV && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
if (DEV_UNLOCK) console.info("[dev] localhost: access wall bypassed + all cars & level themes unlocked");

// Lock every pullable car the player doesn't own yet → the collection becomes "collect the cars".
// Non-pullable cars (Solana Paper / benched / coming-soon) are never locked; poolable() ignores ownership.
for (const c of CAR_DEFS) c.locked = !DEV_UNLOCK && poolable(c) && !inventory.owns(c.name);
// the equipped car (shown on the road) — mirrored onto the garage-showroom turntable
let equippedCar: CarOption = CAR_DEFS[0];
let garageRoom: ReturnType<typeof createGarageRoom> | null = null;
// Equip a car: swap the road GLB, apply its ability, raise the leverage ceiling, mirror onto the
// showroom turntable. Shared by the garage carpicker AND home's equipByName (below).
function equipCar(c: CarOption): void {
  car.setModel(c.url, c.scale, c.yaw);
  setAbility(c.ability);
  carBaseLev = c.baseLev ?? 0;
  tach.rebuild(effRmax());
  equippedCar = c;
  garageRoom?.setCar(c);
}
// Equip by roster name (home's [Drive lobby]). No-op if the name isn't found, or the card is locked
// (not owned) / coming-soon — mirrors the carpicker's own select() gate so home can't equip the undrivable.
function equipByName(name: string): void {
  const c = CAR_DEFS.find((x) => x.name === name);
  if (!c || c.locked || c.comingSoon) return;
  equipCar(c);
}
const garage = createCarPicker(hudRoot, CAR_DEFS, (c) => equipCar(c), () => upgrades.open(), [
  { label: "Music", sub: "synthwave radio", glyph: "♫", get: () => radio.getVolume(), set: (v) => { radio.setVolume(v); writeVolume(MUSIC_VOL_KEY, v); } },
  { label: "SFX", sub: "engine & coins", glyph: "🔊", get: () => audio.getVolume(), set: (v) => { audio.setVolume(v); writeVolume(SFX_VOL_KEY, v); } },
], () => {
  // Account action (garage menu). Refused mid-round — the on-chain round would keep running
  // invisibly and wedge the game on re-login. For a signed-in player this is Log out (real
  // Privy sign-out); for a guest it's Sign in / switch driver. Either way it ends at the
  // identity gate — the gate IS the login screen.
  if (roundActive || engine.getPhase() === "live") { hud.setStatus("Finish this run before signing out."); return; }
  if (identity?.mode === "privy" || signedIn) {
    // signed-in → a real log-out: sign the wallet out, forget the rider, fresh gate (no ✕).
    // Identity-scoped saves: this account's offline progress is stashed under its wallet
    // address. The live keys are then replaced with the guest checkpoint before reloading.
    const stashNs = session.address() || "account";
    // Checkpoint synchronously before the first async boundary. Then wait for every Railway write
    // before disconnecting Privy or reloading, otherwise a fast logout aborts fresh progress.
    stashSave(stashNs);
    void (async () => {
      await accountSync.flush();
      await session.logout();
      // The paddock pair is keyed to the wallet that just went away — drop it (and the seat
      // figure it stands for) so nothing of this account's book can be read by the next one.
      paddockPair?.staging.dispose();
      paddockPair = null;
      bookCents = 0;
      signedIn = false;
      identity = null;
      accountDriverName = null;
      try { presence?.disconnect(); } catch { /* logout still proceeds without presence */ }
      syncPresenceLifecycle();
      accountSync.disable();
      void auth.logout?.(); // clears its keys synchronously — done before the reload below
      clearIdentity();
      wipeSave();
      restoreSave(GUEST_SAVE_NAMESPACE);
      location.reload(); // boots to the identity gate; replaces the in-place gate redraw
    })().catch((error) => {
      console.error("sign-out failed", error);
      hud.setStatus(String((error as Error)?.message ?? error).includes("account_save_failed")
        ? "Saving your progress failed. You are still signed in. Check your connection and try again."
        : "Sign-out failed. Check your connection and try again.");
    });
  } else {
    // guest → "Sign in / switch driver": keep who they are until they COMMIT to a new
    // choice at the gate (prefilled + dismissable — backing out changes nothing)
    showIdentityGate();
  }
}, (reason?: "dismiss" | "chain") => {
  // closed from the strip's Garage building → restore the door prompts (the hamburger stays —
  // it's part of the strip's chrome now that the full HUD lives over the lobby world)
  if (mode === "lobby") { lobbyHud.show(); return; }
  // showroom: ✕ / Esc / backdrop DISMISS leaves the garage; opening Upgrades/Logout ("chain")
  // keeps the room standing behind that panel
  if (mode === "garage" && reason !== "chain") exitGarageToLobby();
}, () => !identity
  ? { label: "Sign in", sub: "play for real SOL" }
  : identity.mode === "guest"
    ? { label: "Sign in", sub: `riding as ${identity.name} · guest — or switch driver` }
    : { label: "Log out", sub: `riding as ${identity.name}` }, {
  // race-level skin picker (menu → World). Shows EVERY skin; unowned ones render SEALED (like a
  // locked car card) and can't be selected — they unlock from crates (Silver/Gold mostly).
  // setWorldTheme (world.setTheme + shader re-warm) is the shared seam.
  list: () => THEMES.map((t) => ({ key: t.key, name: t.name, colors: [t.sky[0], t.sky[1], t.roadEdge], locked: !DEV_UNLOCK && !levels.owns(t.key) })),
  current: () => world?.currentTheme() ?? loadThemeKey(), // the picker opens from the lobby (world built), but fall back to the persisted key if ever read earlier
  set: (key: string) => { setWorldTheme(key); },
}, {
  showGarageAndUpgrades,
  onHome: backOutToHome,
  onHistory: () => { void tradeHistory.open(); },
  onAccessCode: () => openAccessCodeDialog(),
  driverName: {
    current: () => identity?.name ?? null,
    edit: () => openDriverNameDialog(false),
  },
  style: {
    get: () => isToonEnabled(),
    toggle: () => setToonEnabled(!isToonEnabled()),
    subscribe: (cb) => onToonChanged(cb),
  },
});
garageForHydration = garage;
(window as Window & { setSplashProgress?: (pct: number) => void }).setSplashProgress?.(75); // boot milestone: inventory + garage up

// Crate Shop (lobby Crates building): buy a crate → roll a car by rarity odds → reveal. A NEW car
// unlocks in the garage; a DUPLICATE melts to Scrap. Account crates use MagicBlock VRF; only guests
// use client RNG for local practice.
const crateBox = createCrateBox(hudRoot, {
  cars: () => CAR_DEFS,
  grantCar: (name) => inventory.grant(name),
  unlockUI: (name) => garage.grant(name),
  coins: () => upgrades.coins(),
  spend: (n) => upgrades.spend(n),
  addScrap: (n) => upgrades.addScrap(n),
  lockedLevels: () => THEMES.map((t) => t.key).filter((k) => !levels.owns(k)),
  grantLevel: (key) => { levels.grant(key); },
  levelInfo: (key) => { const t = themeOf(key); return { name: t.name, sky: [t.sky[0], t.sky[1]], disc: t.celestialColors[0], grid: [t.grid[0], t.grid[1]] }; },
  lowTier: quality.tier === "low",
  buyWithSol: async (_crateKey, priceSol) => {
    if (identity?.mode !== "privy") throw new Error("sol_payment_requires_sign_in");
    const wallet = session.anchorWallet();
    if (!wallet) throw new Error("sol_payment_wallet_unavailable");
    const signature = await payDevnetSol(wallet, CRATE_TREASURY, priceSol);
    walletSolUnits = applyConfirmedWalletSpend(
      walletSolUnits,
      priceSol,
      ACTIVE_STAKE_CURRENCY.displayUnitDecimals,
    );
    walletSolRequest++; // invalidate any pre-payment wallet read still in flight
    renderKnownBalance();
    reconcileWalletSol();
    return signature;
  },
  // MagicBlock VRF (signed-in only): one randomness request per pull, signed by the same
  // session wallet as rounds. Guests fall through to client RNG (practice parity).
  vrfDraws: () => {
    if (!identity || identity.mode !== "privy") return null;
    const w = session.anchorWallet();
    if (!w) return null;
    return createCrateRollDraws(makeCrateRollIo(w));
  },
  vrfRequired: () => identity?.mode === "privy",
  completeGift: async () => {
    try {
      return (await api.claimWelcome()).granted;
    } catch (error) {
      if (error instanceof ApiError && error.bodyError === "welcome_already_claimed") return false;
      throw error;
    }
  },
  holdCoins: (n) => upgrades.holdCoins(n),
  settleHold: (n, commit) => upgrades.settleHold(n, commit),
  onVrfFail: (msg) => lobbyHud.toast(msg),
  onClose: () => { if (mode === "lobby") lobbyHud.show(); else if (mode === "home") home.show(); },
});

// First-run "How to Play" walkthrough — also reachable from the hamburger "How to play" row, which
// dispatches `raider:howto` on hudRoot. Created here so it exists before the identity-gate callbacks.
const howto = createHowTo(hudRoot);
hudRoot.addEventListener("raider:howto", () => howto.open());

// ── home: the Slopwheels collection screen — the game's boot surface. Booting here (instead of the
// 3D strip) makes your card collection the front door; the lobby/race are reached FROM it. ──
const home = createHome(hudRoot, {
  cars: () => CAR_DEFS,
  owns: (n) => inventory.owns(n),
  equippedName: () => equippedCar.name,
  onDriveLobby: (carName) => { equipByName(carName); exitHomeToLobby(); },
  // Primary footer CTA (Drive the strip): home picks the sensible default car, we equip + enter the
  // lobby via the same path as the per-card Drive lobby.
  onDriveStrip: (carName) => { equipByName(carName); exitHomeToLobby(); },
  // Enter the in-app race: with the tapped card's car, or null (spectate) for Watch & bet.
  onEnterRace: (carName) => enterGrandprix(carName),
  onWatchAndBet: () => enterGrandprix(null),
  onOpenStore: () => crateBox.open(),
});

// ── lobby town · strip dressing · lobby cam · highway oval: ALL DEFERRED behind ensureWorlds() ──
// Declared nullable here and constructed on the first 3D entry (see ensureWorlds() near the mode
// functions). Nothing between here and that first entry renders, so none of this exists at the 2D home.
let lobby: ReturnType<typeof createLobby> | null = null;
let stripCars: ReturnType<typeof createStripCars> | null = null;
let stripBoard: ReturnType<typeof createStripBillboard> | null = null;
let cruisers: ReturnType<typeof createCruisers> | null = null;
let lobbyCam: ReturnType<typeof createLobbyCam> | null = null;
let oval: ReturnType<typeof createOval> | null = null;
// live dial / kill-switch for the lobby's synthwave backdrop — tweak from the console:
//   __backdrop.setOpacity(0.5) · __backdrop.black() · __backdrop.show()  (no-ops until the lobby is built)
(window as any).__backdrop = {
  setOpacity: (x: number) => lobby?.backdrop.setOpacity(x),
  black: () => lobby?.backdrop.setVisible(false),
  show: () => lobby?.backdrop.setVisible(true),
  current: () => lobby?.backdrop.current(),
};
// Low tier: dressing beyond this player-distance stops rendering entirely (roots hidden).
// Derived from the real lot scale (core/lobby-layout LOT_BOUNDS 180-half): 225 keeps the
// whole meet + both cruisers visible from spawn, and drops the entrance meet only once
// you're across the plaza at the north arc — where it's sub-pixel dressing anyway.
const DRESSING_CULL_D = LOT_BOUNDS.z * 1.25;

// toon depth-edge pass: exclude the solid cars (they already carry thick inverted-hull outlines, so a
// thin screen edge would double-line them) and gate it to toon style + the `toon.edgePass` kill-switch
// (localStorage, default ON). No-op when bloom/composer is off (low tier). The drivable car is excluded
// EAGERLY (grandprix-from-home renders through this pass); ensureWorlds() appends the lobby dressing.
if (post) {
  post.edge.exclude = [car.group];
  const applyEdge = (): void => { post.edge.enabled = isToonEnabled() && edgePassEnabled(); };
  applyEdge();
  onToonChanged(applyEdge);
  console.info(`[toon] edge pass ${post.edge.enabled ? "ON" : "off"} (toon=${isToonEnabled()}, flag=${edgePassEnabled()})`);
}

// ── DEV Light Lab registrations (key L / ?lightlab=1). Global = shared toon engine knobs; the main
// game's bloom + scene lights/fog live in the perps-road folder (per-context, never clobbers the
// race-preview presets). Per-world lights register from their own modules. ──
registerLightLab("Global", { controls: [
  { key: "outlineScale", label: "outline scale", kind: "num", min: 0, max: 3, step: 0.05, get: () => getOutlineWidth(), set: (v) => setOutlineWidth(v) },
  { key: "rampFloor", label: "toon ramp floor", kind: "color", get: () => getWorldRampBand(0), set: (v) => setWorldRampBand(0, v) },
  { key: "rampBand2", label: "toon ramp band 2", kind: "color", get: () => getWorldRampBand(1), set: (v) => setWorldRampBand(1, v) },
  ...(post ? [
    { key: "edgePass", label: "edge pass", kind: "bool" as const, get: () => post.edge.enabled, set: (v: boolean) => { setEdgePassEnabled(v); post.edge.enabled = v && isToonEnabled(); } },
    { key: "edgeDepth", label: "edge depth thresh", kind: "num" as const, min: 0.01, max: 2, step: 0.01, get: () => post.edge.depthThreshold, set: (v: number) => { post.edge.depthThreshold = v; } },
    { key: "edgeNormal", label: "edge normal thresh", kind: "num" as const, min: 0.01, max: 2, step: 0.01, get: () => post.edge.normalThreshold, set: (v: number) => { post.edge.normalThreshold = v; } },
    { key: "edgeThickness", label: "edge thickness px", kind: "num" as const, min: 0.5, max: 4, step: 0.05, get: () => post.edge.thickness, set: (v: number) => { post.edge.thickness = v; } },
  ] : []),
] });
// stable handle to the perps-road Fog (grandprix swaps scene.fog out+back — see the fog controls below)
const perpsRoadFog = ctx.scene.fog instanceof THREE.Fog ? ctx.scene.fog : null;
registerLightLab("perps-road", { controls: [
  { key: "ambient", label: "ambient", kind: "num", min: 0, max: 3, step: 0.01, get: () => ctx.ambient.intensity, set: (v) => { ctx.ambient.intensity = v; } },
  { key: "ambientColor", label: "ambient color", kind: "color", get: () => "#" + ctx.ambient.color.getHexString(), set: (v) => ctx.ambient.color.set(v) },
  { key: "key", label: "key (directional)", kind: "num", min: 0, max: 3, step: 0.01, get: () => ctx.key.intensity, set: (v) => { ctx.key.intensity = v; } },
  { key: "keyColor", label: "key color", kind: "color", get: () => "#" + ctx.key.color.getHexString(), set: (v) => ctx.key.color.set(v) },
  ...(post ? [
    { key: "bloomStrength", label: "bloom strength", kind: "num" as const, min: 0, max: 3, step: 0.01, get: () => post.bloom.strength, set: (v: number) => { post.bloom.strength = v; } },
    { key: "bloomRadius", label: "bloom radius", kind: "num" as const, min: 0, max: 1, step: 0.01, get: () => post.bloom.radius, set: (v: number) => { post.bloom.radius = v; } },
    { key: "bloomThreshold", label: "bloom threshold", kind: "num" as const, min: 0, max: 1, step: 0.01, get: () => post.bloom.threshold, set: (v: number) => { post.bloom.threshold = v; } },
  ] : []),
  // Bind to the perps-road Fog OBJECT captured at boot, NOT live `ctx.scene.fog`: grandprix temporarily
  // swaps scene.fog for the race's dusk fog (restoring this same object on exit). Reading live scene.fog
  // here would show — and worse, SAVE ALL would persist — the RACE fog into the perps-road preset.
  ...(perpsRoadFog ? [
    { key: "fogColor", label: "fog color", kind: "color" as const, get: () => "#" + perpsRoadFog.color.getHexString(), set: (v: string) => perpsRoadFog.color.set(v) },
    { key: "fogNear", label: "fog near", kind: "num" as const, min: 0, max: 800, step: 1, get: () => perpsRoadFog.near, set: (v: number) => { perpsRoadFog.near = v; } },
    { key: "fogFar", label: "fog far", kind: "num" as const, min: 0, max: 2000, step: 1, get: () => perpsRoadFog.far, set: (v: number) => { perpsRoadFog.far = v; } },
  ] : []),
] });
// ── shader precompile: kill the first-sight compile stall ──────────────────
// three builds one GPU program per (material × visible-light-set), and every mode — strip,
// race road, highway, showroom — shows a DIFFERENT light set. Entering a mode for the first
// time used to glCompileShader its whole program set mid-frame (a hitch spike right as you
// drive through a gate). Warm each mode's visibility configuration up front (run once at the end of
// ensureWorlds() as part of the first build, and again after setTheme builds fresh materials): flip
// only the `visible` flags, compile, restore — nothing renders in between, so the player never sees it.
function precompileModes(): void {
  if (!world || !lobby || !oval) return; // only meaningful once ensureWorlds() has built the groups (guards the setTheme re-warm rAF)
  const showroom = garageRoom?.group;
  const groups = [world.group, pickups.group, fireTrail.group, lobby.group, oval.group, ...(showroom ? [showroom] : [])];
  const configs = [
    [world.group, pickups.group, fireTrail.group], // race road
    [lobby.group],                                 // the strip
    [oval.group],                                  // highway
    showroom ? [showroom] : [],                    // garage showroom
  ];
  const before = groups.map((g) => g.visible);
  for (const on of configs) {
    for (const g of groups) g.visible = on.includes(g);
    ctx.renderer.compile(ctx.scene, ctx.camera);
  }
  groups.forEach((g, i) => { g.visible = before[i]; });
}
let highwayMotion: HighwayMotion | null = null;
let highwayConfirmedLev = 100;
// drive-mode body language (all modes): eased roll into corners + squat/dive on
// throttle/brake — core/body-language owns the math. Visual only — never physics or money.
let body: BodyState = { roll: 0, pitch: 0 };
let prevDriveSpeed = 0; // freedrive speed last frame (lobby + highway accel derive)
// road-slope sampler (highway + racer share the pattern): surface height ±SLOPE_SAMPLE
// around the car, nose pitched by atan2(rise, 2·SLOPE_SAMPLE), clamped so a terrain
// step can't flip the car
const SLOPE_SAMPLE = 3.4;
const SLOPE_CLAMP = 0.35;
let hwBillboardCd = 0; // billboard redraw cooldown (CanvasTexture upload ≈ not free)
// "grandprix" is the in-app race mode: entered from home with the player's owned car (createRaceGame
// owns the track/sim/HUD; the host just drives update+render and disposes on exit).
// Default "home": home IS the boot surface, and the boot tail always calls enterHome()/enterLobby()
// (which sets this) before the first frame — so no code ever reads this default today. It's a safety
// floor: if the boot tail is ever re-ordered so a frame runs first, "home" falls into the harmless
// reschedule branch (frame() returns early for mode==="home") instead of the race branch's `world!` null-deref.
let mode: "race" | "lobby" | "highway" | "garage" | "home" | "grandprix" = "home";
let raceGame: RaceGame | null = null; // the live in-app race, or null when not in grandprix
// perps renderer tone-mapping saved on grandprix entry, restored on its single exit (the race shares the
// harness's ACES operator; the perps world runs NoToneMapping/1.0 with tone-mapping deferred to OutputPass)
let prevRaceToneMapping: THREE.ToneMapping = ctx.renderer.toneMapping;
let prevRaceExposure = ctx.renderer.toneMappingExposure;
let garageEnterT = 0;        // seconds since entering the showroom (drives the reveal push-in)
let garageMenuShown = false; // one-shot: auto-open the collection menu once the reveal has played
let drive: DriveState = { x: LOBBY_SPAWN.x, z: LOBBY_SPAWN.z, heading: 0, speed: 0, steer: 0 };
const DOOR_DWELL_S = 0.8; // seconds inside an entry ring before it opens — long enough to read the offer card
let doorDwell = 0;
let doorArmed = true; // disarmed after entering a building until the car leaves every doorway (no instant re-open)
let steerNorm = 0; // steering from the pointer drag (-1..1), shared with the lobby

// ── strip chrome: cruise ⇄ race ─────────────────────────────────────────────
// Cruising the strip shows NOTHING but the balance chip + hamburger — the world is the
// UI. The TRACK gate drives you onto the track, where the full racing chrome (graph,
// price, timer, tach, call/amount, GO) lives exactly as it always did.
function setChrome(state: "cruise" | "race") {
  hud.setMinimal(state === "cruise");
  coins.setVisible(true);
  scrap.setVisible(true);
  coins.setLobbyPosition(state === "cruise");
  scrap.setLobbyPosition(state === "cruise");
  garage.setMenuTop(state === "cruise"); // strip: hamburger rides the top row (price chip's slot)
}

// ── mode transitions ────────────────────────────────────────────────────────
// Deferred-world ref idiom (Task 8): the 3D refs (world/lobby/oval/lobbyCam/strip*) are `T | null`,
// built lazily by ensureWorlds(). Inside these mode fns and the frame branches — which run only AFTER
// a mode entry that called ensureWorlds() — assert non-null with `!` and a comment naming that guarantee.
// Reserve `?.` for genuinely out-of-flow callers (async presence/settle, dev hooks, pre-first-entry skin reads).
//
// When you drive OUT of a building (Track / Garage) the car should emerge AT that building's doorway
// nosed BACK at the building it just left — you instantly see where you came from, not teleported to
// the south entrance. Set when a building is entered, consumed once by the next enterLobby(). null →
// the plain south spawn (first boot, or no building of origin).
let exitFrom: BuildingKind | null = null;

/** where enterLobby() drops the car: just outside the origin building's door, nose pointed back at the
 *  building you left (clear of the door ring so driving off can't instantly re-trigger the entry). */
function lobbyEntryPose(): DriveState {
  const kind = exitFrom;
  exitFrom = null;
  const spawn: DriveState = { x: LOBBY_SPAWN.x, z: LOBBY_SPAWN.z, heading: 0, speed: 0, steer: 0 };
  if (!kind) return spawn;
  const pose = doorExitPose(kind); // outside the door ring, facing the building it left
  if (!pose) return spawn;
  return { ...pose, speed: 0, steer: 0 };
}

function enterLobby() {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return; // no mode switch while a GO is in flight
  ensureWorlds(); // build the 3D world/lobby/oval/garage on the first entry from home (memoized no-op after)
  mode = "lobby";
  highwayControls.hide();
  hud.setOpenPosition(false);
  drive = lobbyEntryPose(); // at the door of the building you left (Track/Garage), else the south spawn
  doorDwell = 0;
  doorArmed = true;
  body = { roll: 0, pitch: 0 }; prevDriveSpeed = 0;
  // pitch must be body-local under yaw (YXZ), or squat/dive reads as a sideways
  // lean when heading east/west; every mode entry asserts its own order
  car.group.rotation.order = "YXZ";
  car.group.visible = true; // restore the drivable car (the garage showroom may have hidden it)
  lobbyCam!.reset();          // non-null: ensureWorlds() ran at the top of this function
  world!.group.visible = false;
  pickups.group.visible = false;
  fireTrail.group.visible = false;
  lobby!.show();
  // cruise chrome: the world is the UI — balance + hamburger, nothing else
  setChrome("cruise");
  lobbyHud.show();
  syncPresenceLifecycle();
  audio.resume(); radio.resume();
}

function exitLobby() {
  ensureWorlds(); // the only path into "race" mode — guarantees the world exists for the race frame branch (memoized no-op after the first)
  mode = "race";
  syncPresenceLifecycle();
  setChrome("race");
  lobby!.hide();              // non-null: ensureWorlds() above
  lobbyHud.hide();
  lobbyHud.setPrompt(null);
  world!.group.visible = true;
  pickups.group.visible = true;
  fireTrail.group.visible = true;
  // restore the road car pose; the chase cam takes back over next frame.
  // market (BTC/ETH/SOL) stays whatever it was — it's chosen from the in-race HUD tabs, not the lobby.
  lane = { x: 0, vx: 0, yaw: 0, steer: 0 };
  carXTarget = 0;
  body = { roll: 0, pitch: 0 };
  prevRoadSpeed = 0;
  car.group.position.set(0, 0, CAR_Z);
  car.group.rotation.set(0, 0, 0);
  car.group.rotation.order = "YXZ"; // same convention as every mode (see the boot-time note)
}

// ── highway: automatic divided-oval perpetuals ─────────────────────────────
// Direction selects the carriageway. Leverage controls automatic speed, not steering.
function enterHighway(restoring = false) {
  if (!restoring && modeSwitchBlocked({ opening, phase: engine.getPhase(), roundActive })) return;
  unwindGrandprix(); // the async boot-restore fires enterHighway(true) whatever mode the player reached; if they were mid-grandprix, tear the race down (dispose + lights/tone/car restore) BEFORE the highway takes over. No-op when no race is live, so from-lobby entry is unaffected. Chosen here (not restoreHighwayPosition) because enterHighway is the single choke point for EVERY highway path — current and future.
  ensureWorlds(); // covers every enterHighway path: from-lobby, the boot-restore (restoring=true), and the __hw dev hook — all need the oval/world built
  mode = "highway";
  syncPresenceLifecycle();
  highwayConfirmedLev = highwayControls.value();
  highwayControls.setConfirmed(highwayConfirmedLev);
  highwayControls.show();
  highwayMotion = seedHighwayMotion(session.address() || identity?.name || "practice", controls.dir());
  body = { roll: 0, pitch: 0 }; prevDriveSpeed = 0;
  lobby!.hide(); lobbyHud.hide(); lobbyHud.setPrompt(null); // non-null: ensureWorlds() above
  world!.group.visible = false;
  pickups.group.visible = false;
  fireTrail.group.visible = false;
  oval!.show();
  setChrome("race"); // the highway uses the full driving chrome
  tach.rebuild(HIGHWAY_MAX_LEV);
  // Racer-only ability buttons are disabled here. The Highway position owns leverage.
  nitro.setEnabled(false); flux.setEnabled(false); magnet.setEnabled(false); autoExit.setEnabled(false); barrelRoll.setEnabled(false);
  hwBillboardCd = 0; // fresh entry → redraw the billboard immediately (no stale asset/price beat)
  // pitch composes over yaw on the hills (YXZ = yaw outer, pitch local); all modes
  // share YXZ since the 7H racer rebuild — see the boot-time note
  car.group.rotation.order = "YXZ";
  audio.resume(); radio.resume();
}

function exitHighwayToLobby() {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase(), roundActive })) return;
  oval?.hide(); // reached only from highway (worlds built); optional-chain guards the __hw dev hook called out-of-flow. enterLobby() at the end self-ensures anyway
  highwayPresenceGeneration += 1;
  verifiedHighwayCars = [];
  highwayControls.setSentiment(0, 0, 0);
  highwayControls.hide();
  hud.setOpenPosition(false);
  tach.rebuild(effRmax());
  setAbility(ability); // restore the car's own buttons/toggles
  audio.engine(0, false); // the highway drives the drone every frame; silence it for the lobby
  enterLobby();
}

// ── garage: the drive-in showroom (your equipped car hero-lit on a turntable) ──────────────
function enterGarage() {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase(), roundActive })) return;
  ensureWorlds(); // reached from the lobby (already built) or the __hw dev hook — memoized no-op after the first
  mode = "garage";
  syncPresenceLifecycle();
  lobby!.hide(); lobbyHud.hide(); lobbyHud.setPrompt(null); // non-null: ensureWorlds() above
  world!.group.visible = false;
  pickups.group.visible = false;
  fireTrail.group.visible = false;
  car.group.visible = false; // the drivable car parks off-screen; the showroom has its own on the turntable
  garageRoom?.show();
  garageRoom?.setCar(equippedCar); // whatever's equipped rides the turntable
  setChrome("cruise");             // no racing HUD — hamburger + balance chip only
  garageEnterT = 0;
  garageMenuShown = false;
  audio.resume(); radio.resume();
}

function exitGarageToLobby() {
  garage.setShowroom(false); // drop the translucent backdrop before the menu is used over the strip
  garageRoom?.hide();
  enterLobby();
}

// ── home: the collection screen is the boot surface (a pure-DOM overlay; no 3D render behind it) ──
// Deferred 3D construction. The game boots to the 2D home with NONE of this built; the FIRST entry into
// any 3D mode (drive-lobby, race track, highway, garage) calls ensureWorlds() to build it once. Memoized
// on `world` — the first non-null assignment latches it, so every later call is a no-op. Everything here
// used to run eagerly at module load; moving it off the boot path is what lets home render instantly.
function ensureWorlds(): void {
  if (world) return; // already built — no-op
  // ── race world (skinned per the persisted theme) ──
  const w = createWorld(quality.detail);
  world = w;
  ctx.scene.add(w.group);
  refreshToonStyle(); // cel-shade the freshly-built world roots (boot already set the toon-ui body class)

  // ── lobby: the economy-hub town ──
  // the map button drops you into a giant drivable neon lot with 4 functional buildings —
  // Garage (cars), Upgrades, Crates (coming soon), Track (back to the race), plus live presence.
  const lob = createLobby(quality.detail, (carId) => {
    const carDef = CAR_DEFS.find(({ name }) => name === carId);
    return carDef ? { url: carDef.url, scale: carDef.scale, yaw: carDef.yaw } : null;
  });
  lobby = lob;
  ctx.scene.add(lob.group);

  // parked hero cars + gamertags around the plaza — the car-meet dressing (rides the lobby
  // group's visibility). Names are set dressing today; a presence feed fills these slots later.
  const stripMeetSpecs = [
    { url: "/models/skull.glb", yaw: Math.PI / 2, tag: "liq_dodger", color: "#ff4d6d" },
    { url: "/models/pink-rod.glb", yaw: Math.PI / 2, tag: "moonbag_mia", color: "#ff39c0" },
    { url: "/models/six-wheeler.glb", yaw: Math.PI / 2, tag: "haulin_hal", color: "#ffd166" },
    { url: "/models/clown-car.glb", yaw: Math.PI / 2, tag: "honkmaster", color: "#27e7ff" },
    { url: "/models/slot-machine.glb", yaw: Math.PI / 2, tag: "triple7s_tony", color: "#14f195" },
  ];
  // Low tier: the five hero GLBs are the vertex mountain facing the town square — park only
  // the two LIGHTEST (they land in the entrance-flanking slots, so the meet still reads).
  // The heavier three are never even fetched. High tier parks the full meet, untouched.
  const sCars = createStripCars(quality.detail === "reduced" ? lightestSpecs(stripMeetSpecs, 2) : stripMeetSpecs);
  stripCars = sCars;
  lob.group.add(sCars.group);
  // the jumbotron over the arc — recent action in lights. Simulated feed until presence
  // lands; the player's own settles push onto it live (finalizeSettled → noteSettle).
  const sBoard = createStripBillboard();
  stripBoard = sBoard;
  // centred on the far (north) side of the plaza, aimed straight back at the spawn so it reads
  // head-on the moment you enter — a stadium scoreboard facing the crowd at the starting point.
  const stripBoardPos = { x: 0, z: -150 };
  sBoard.group.position.set(stripBoardPos.x, 0, stripBoardPos.z);
  sBoard.group.rotation.y = Math.atan2(LOBBY_SPAWN.x - stripBoardPos.x, LOBBY_SPAWN.z - stripBoardPos.z); // face the starting point
  lob.group.add(sBoard.group);
  // two ambient cruisers lapping the plaza — motion so the strip never reads frozen.
  // (Two IS the low-tier dressing cap — cruisers.ts hard-slices to 2 — so no tier filter here;
  // on `reduced` they're distance-culled per frame with the parked meet instead.)
  const cru = createCruisers([
    { url: "/models/magnet.glb", scale: 0.75, yaw: Math.PI / 2, tag: "coin_goblin", color: "#b06bff" },
    { url: "/models/shopping-cart.glb", scale: 0.65, yaw: Math.PI / 2, tag: "cart_bandit", color: "#ff8c42" },
  ]);
  cruisers = cru;
  lob.group.add(cru.group);
  // Lobby-dressing GLBs (~120MB across 7 cars) used to start streaming at construction time —
  // decode + texture uploads landing as hitches under the first seconds of play. Load them
  // AFTER the first rendered frame instead (double rAF: the first 3D frame renders the strip,
  // the second starts the loads), SEQUENTIALLY (each GLB starts when the previous is in — one
  // long smear, never a burst), each shader-warmed via compileAsync before it attaches.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const warm = (o: THREE.Object3D) => ctx.renderer.compileAsync(o, ctx.camera, ctx.scene);
    void sCars.load(warm).then(() => cru.load(warm));
  }));
  // append the lobby dressing to the toon edge-pass exclusions (the drivable car was excluded eagerly)
  if (post) post.edge.exclude = [car.group, cru.group, sCars.group];

  // ── camera rig + highway oval ──
  lobbyCam = createLobbyCam();
  const ov = createOval();
  oval = ov;
  ctx.scene.add(ov.group);

  // drive-in garage showroom: your equipped car hero-lit on a turntable (its own world, like the oval)
  const gr = createGarageRoom(ctx.renderer);
  garageRoom = gr;
  ctx.scene.add(gr.group);
  gr.setCar(equippedCar);

  // Warm every mode's shader programs now the groups exist. This used to run at boot under the splash;
  // with the world deferred it runs once here, as the tail of the first build — the FIRST 3D frame is
  // then already compiled (no mid-drive glCompileShader hitch). Home dismissed the splash long ago, so
  // this cost lands on the home→lobby transition instead (grandprix-from-home warms via its own compile).
  precompileModes();
}
function enterHome(): void {
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;
  mode = "home";
  syncPresenceLifecycle(); // home carries no presence — drop the lobby ghost on the lobby→home back-out
  lobbyHud.hide(); home.show();
  (window as Window & { hideSplash?: () => void }).hideSplash?.(); // home-ready IS boot-ready
}
function exitHomeToLobby(): void { home.hide(); ensureWorlds(); enterLobby(); }

// ── grandprix: the in-app spectator/owner race — createRaceGame owns the track, sim, and HUD; the
// host just drives update()+render each frame and disposes on exit. Entered from home with the
// tapped card's car (Enter race) or null (Watch & bet, all-house field). ──
function enterGrandprix(playerCarName: string | null): void {
  if (mode === "grandprix" || raceGame) return;                          // re-entry guard: a double-tapped race button (Android retargets the trailing click) would orphan + leak a whole race
  if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;  // no mode switch mid-GO
  const from = mode; // the mode this entry was asked FOR — see the re-check across the await below
  // Bound to a const and called on the next line rather than written as an inline IIFE ON PURPOSE:
  // TypeScript carries the guards' narrowing INTO an IIFE, so `mode` would still read as "not
  // grandprix" below — a narrowing that cannot survive the await between the two. Breaking the IIFE
  // shape hands the re-check the declared union again, which is the whole point of re-checking.
  const openRace = async (): Promise<void> => {
    // A connected wallet plays the REAL book — the same singleton Race the crank cycles on
    // devnet; a guest keeps the local sim byte-for-byte (book absent ⇒ pre-chain behavior).
    // Build it BEFORE the mode flips: a couple of primed reads, and on any failure the race
    // still opens on the local sim rather than half-opening on a dead chain.
    let book: Awaited<ReturnType<typeof createChainBookSource>> | undefined;
    const pad = paddockFor();
    if (pad) {
      try {
        book = await createChainBookSource(pad.client, { staging: pad.staging });
        // Entering a race is the player opting back IN to a staged seat, so it lifts any
        // suspension a previous Cash Out left behind — without this the seat never stages
        // again. resume() first: a suspended controller no-ops the ensure() below.
        pad.staging.resume();
        // The moment we know a bet will be needed is NOW — stage the default stake's buffer
        // while the player is still watching the market fill in.
        pad.staging.ensure(BigInt(unitsToBase(DEFAULT_STAKE)));
        bookCents = book.betable?.() ?? 0; // the primed snapshot makes the panel's gate real
      } catch (e) {
        console.warn("[grandprix] chain book unavailable — local sim:", e);
      }
    }
    // Re-assert the guards across the await: a double-tap or a mode change while the ER read was
    // in flight must not build a second race over the first, nor drop a race onto a mode that
    // moved on — the highway boot-restore is exactly such a preemptor (see unwindGrandprix).
    if (mode === "grandprix" || raceGame) return;
    if (mode !== from) return;
    if (modeSwitchBlocked({ opening, phase: engine.getPhase() })) return;
    const seed = (Math.random() * 1e9) >>> 0;
    // Build the race FIRST: if construction throws (bad GLB path, track build) we bail here, BEFORE any
    // irreversible mode/visibility/chrome mutation — the app stays on home instead of a half-torn state.
    // House field: unowned-but-unlocked defs stay eligible; buildGrid itself drops pool:false/comingSoon
    // and picks the player by name (an unowned/unknown name → all-house spectate).
    raceGame = createRaceGame({
      scene: ctx.scene, camera: ctx.camera, hudParent: hudRoot,
      // The chain race is ALWAYS a full field: `Race.entrants` permutes GRID_SIZE slots, and
      // `setupRace` paces `cars[entrants[slot]]` — a grid short of that crashes on the first
      // market (fresh accounts own almost nothing). House opponents aren't the player's to own,
      // so the chain show fills from the FULL roster; guests keep the unlock-filtered field.
      grid: buildGrid(book ? CAR_DEFS : CAR_DEFS.filter((c) => !c.locked || inventory.owns(c.name)), playerCarName, mulberry32(seed)),
      seed, lowTier: quality.tier === "low",
      book, // undefined for a guest / an unreachable book → race-mode falls back to its local sim
      // race-mode lights the race like the dev harness (own hemi/key/rim + dusk fog + full IBL) and
      // registers the DEV "race-track" Light Lab folder — the perps main-scene lights are too dark for it.
      provideSceneLighting: true,
      // thin accessor so the race-track Light Lab can expose an "exposure" knob over the host renderer
      exposure: { get: () => ctx.renderer.toneMappingExposure, set: (v) => { ctx.renderer.toneMappingExposure = v; } },
      onExit: () => exitGrandprixToHome(),
    });
    mode = "grandprix";
    // The race owns the whole screen (race-hud board + bet panel). Hide the perps 3D world — world +
    // pickups + fire-trail AND the drivable car (it can poke into some race cam angles) — the same
    // groups enterHighway hides, plus the car. Then MUTE the two perps main-scene lights (ambient + key,
    // the scene-root pair from createScene): they're the only lights that reach the race group (every
    // other group is hidden here), and their moody purple/pink wash is exactly what made the race look
    // wrong. With them off the race renders under ONLY its harness-matched rig. exitGrandprix restores.
    if (world) world.group.visible = false; // may be null: grandprix is enterable straight from home before any lobby/3D visit ever built the world (nothing to hide then)
    // The strip plaza (and every bit of dressing parented under it — meet cars, cruisers, board):
    // a from-LOBBY entry (the TRACK gate) leaves it standing in the race's infield otherwise.
    // Null before the first lobby visit; already hidden on a from-home entry — both no-ops.
    lobby?.hide();
    lobbyHud.setPrompt(null); // a lingering "enter TRACK" door card must not survive into the race
    pickups.group.visible = false; fireTrail.group.visible = false; car.group.visible = false; // eager groups — always exist
    ctx.ambient.visible = false; ctx.key.visible = false;
    // Share the harness's tonal operator: the perps world runs NoToneMapping (tone-mapping deferred to the
    // composer's OutputPass, which reads renderer.toneMapping live), so ACES here rolls off the neon like the
    // harness — its original "flat neon fix". Save + restore on exit; exposure comes from the race-track preset.
    prevRaceToneMapping = ctx.renderer.toneMapping;
    prevRaceExposure = ctx.renderer.toneMappingExposure;
    ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    ctx.renderer.toneMappingExposure = pNum("race-track", "exposure", 1.05);
    // Kill the cold-entry compile freeze (the "dark spot at race start"): the race track + environment
    // programs were never in precompileModes() (the race group doesn't exist at boot), so their first
    // render used to glCompileShader ~30 programs mid-frame. Warm them NOW — while home still covers the
    // canvas and under the final light config set just above — so the first VISIBLE race frame is already
    // compiled. (Diagnosed in-browser: cold entry spiked one 124ms frame as programs jumped 116→145; a
    // warm re-entry has no such spike.)
    ctx.renderer.compile(ctx.scene, ctx.camera);
    syncPresenceLifecycle(); // grandprix carries no presence (allowlist predicates keep it dark); this
                             // still DISCONNECTS the lobby ghost when arriving from a presence mode
    home.hide(); lobbyHud.hide(); // hide home LAST — it masked the compile stall a beat ago
    // Hide the perps driving chrome (GO dock, tach, market tabs, price/timer/× via setMinimal; coin/scrap
    // counters). enterLobby/exitLobby + setChrome re-establish every one of these downstream, so leaving
    // grandprix restores it for free.
    hud.setMinimal(true);
    coins.setVisible(false); scrap.setVisible(false);
  };
  void openRace();
}
// Tear a live in-app race down and hand every host resource it borrowed back to the perps world:
// dispose() (which restores the scene fog/background/env-intensity) + null the ref, un-mute the two
// main-scene lights, restore the saved tone-mapping operator + exposure, and re-show the drivable car
// the race hid. IDEMPOTENT — a no-op when no race is live — so any mode that can preempt grandprix must
// call it defensively before taking over, or the race's mutations strand (track group + HUD/bet-panel
// DOM left up, ambient/key muted, ACES exposure live, car.group hidden). The async highway boot-restore
// is exactly such a preemptor: it fires enterHighway() long after boot, whatever mode the player reached.
function unwindGrandprix(): void {
  if (!raceGame) return; // no in-app race live → nothing stranded (idempotent no-op)
  raceGame.dispose(); raceGame = null; // dispose restores the scene fog/background/env-intensity
  ctx.ambient.visible = true; ctx.key.visible = true; // un-mute the perps main-scene lights the race muted
  ctx.renderer.toneMapping = prevRaceToneMapping; // hand the perps world back its NoToneMapping operator
  ctx.renderer.toneMappingExposure = prevRaceExposure;
  car.group.visible = true; // re-show the drivable car the race hid (enterHighway/enterHome won't)
}
function exitGrandprixToHome(): void {
  unwindGrandprix();
  enterHome(); // handles mode, presence sync, home.show, idempotent hideSplash
}

/** drive-into-a-building action. Economy screens open over the lobby; the Track gate leaves to the race. */
function triggerBuilding(kind: BuildingKind) {
  switch (kind) {
    case "garage": exitFrom = "garage"; enterGarage(); break;        // drive-in showroom (car + collection, and Upgrades)
    case "crates": lobbyHud.hide(); crateBox.open(); break;           // open a crate → pull a car
    case "scrapyard": lobbyHud.toast("ScrapYard — coming soon"); break; // collect scrap, not built yet
    case "track": exitFrom = "track"; exitLobby(); break;            // onto the track — full racing HUD, GO lives there
    // THE race — the same chain-book grandprix home's Watch & bet opens, with the equipped car on the grid
    case "race": enterGrandprix(equippedCar.name); break;
  }
}

// The floating home button moved under the ☰ menu (user call 2026-07-28) — same contextual
// back-out it always performed: race/highway/garage step back to the strip, the strip backs
// out to the collection (home). Hoisted so the carpicker's menuFeatures can reference it.
function backOutToHome(): void {
  if (mode === "race") enterLobby();
  else if (mode === "highway") exitHighwayToLobby();
  else if (mode === "garage") exitGarageToLobby();
  else if (mode === "lobby") enterHome(); // the strip is no longer root — back it out to the collection
}
const lobbyHud = createLobbyHud(hudRoot);
let presence: PresenceClient | null = null;
const presenceHud = createPresenceHud(hudRoot, (kind) => presence?.emote(kind));
const highwayRoundReader = createHighwayRoundReader();
let highwayPresenceGeneration = 0;
let verifiedHighwayCars: Array<{
  id: string;
  roundPda: string;
  dir: 1 | -1;
  lev: number;
  motion: HighwayMotion;
}> = [];
const highwayVerificationCache = new Map<string, { signature: string; expires: number; valid: boolean }>();
const highwayVerificationInflight = new Map<string, Promise<PresenceHighway | null>>();

async function verifyCachedHighway(advertised: PresenceHighway): Promise<PresenceHighway | null> {
  const signature = `${advertised.wallet}:${advertised.asset}:${advertised.dir}:${advertised.lev}`;
  const cached = highwayVerificationCache.get(advertised.roundPda);
  if (cached && cached.signature === signature && cached.expires > Date.now()) {
    return cached.valid ? advertised : null;
  }
  const inflightKey = `${advertised.roundPda}:${signature}`;
  const existing = highwayVerificationInflight.get(inflightKey);
  if (existing) return existing;
  const verification = verifyHighwayPresence(advertised, highwayRoundReader).then((verified) => {
    highwayVerificationCache.set(advertised.roundPda, {
      signature,
      expires: Date.now() + 2_000,
      valid: verified !== null,
    });
    return verified;
  }).finally(() => highwayVerificationInflight.delete(inflightKey));
  highwayVerificationInflight.set(inflightKey, verification);
  return verification;
}

async function updateVerifiedHighway(players: PresencePlayer[]): Promise<void> {
  const generation = ++highwayPresenceGeneration;
  const candidates = selectRemoteHighwayPlayers(players, session.address(), asset);
  const checked = await Promise.all(candidates.map(async (player) => ({
    id: player.id,
    state: await verifyCachedHighway(player.highway!),
  })));
  if (generation !== highwayPresenceGeneration || mode !== "highway") return;

  const prior = new Map(verifiedHighwayCars.map((car) => [`${car.id}:${car.roundPda}`, car]));
  verifiedHighwayCars = checked.flatMap(({ id, state }) => {
    if (!state) return [];
    const key = `${id}:${state.roundPda}`;
    const existing = prior.get(key);
    const motion = existing?.motion ?? synchronizedHighwayMotion(
      state.roundPda,
      state.dir,
      state.lev,
      Date.now() / 1000,
    );
    return [{ id, roundPda: state.roundPda, dir: state.dir, lev: state.lev, motion }];
  });
  const longs = verifiedHighwayCars.filter(({ dir }) => dir === 1).length;
  const shorts = verifiedHighwayCars.length - longs;
  const average = verifiedHighwayCars.length === 0
    ? 0
    : verifiedHighwayCars.reduce((sum, { lev }) => sum + lev, 0) / verifiedHighwayCars.length;
  highwayControls.setSentiment(longs, shorts, average);
}

presence = createPresenceClient({
  baseUrl: (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080",
  auth,
  name: () => identity?.name ?? "",
  carId: () => equippedCar.name,
  onSnapshot: (players, localId) => {
    try {
      if (mode === "highway") void updateVerifiedHighway(localId === null ? [] : players);
      else lobby?.setRemoteCars(localId === null ? [] : players); // presence is async — a snapshot could land before the first 3D entry built the lobby
    } catch {
      // Presence visuals are optional. A renderer failure must not interrupt local driving.
    }
  },
  onJoin: (player) => lobbyHud.toast(`${player.name} rolled in`),
  onLeave: (player) => lobbyHud.toast(`${player.name} rolled out`),
  onEmote: (event, localId) => routePresenceEmote(event, localId, {
    local: (kind) => localEmoteVisual.pulse(kind),
    remote: (remoteEvent) => lobby?.emoteRemote(remoteEvent), // async remote emote — guard against it arriving before the lobby is built
  }),
  onStatus: (status, count) => presenceHud.setState(status, count),
  onError: (code) => {
    if (code === "lobby_full") lobbyHud.toast("Paddock full");
  },
});

function syncPresenceLifecycle(): void {
  try {
    presenceHud.setVisible(presenceHudShouldShow(mode));
    if (presenceShouldConnect({ mode, hasIdentity: identity !== null })) presence?.connect();
    else presence?.disconnect();
  } catch {
    try { presenceHud.setState("offline", 0); } catch { /* presence cannot block a mode switch */ }
  }
}

function reconnectPresenceForIdentity(): void {
  try { presence?.disconnect(); } catch { /* presence is best-effort */ }
  syncPresenceLifecycle();
}

addEventListener("pagehide", () => {
  try { presence?.disconnect(); } catch { /* the page is already tearing down */ }
});
addEventListener("pageshow", (event) => {
  if ((event as PageTransitionEvent).persisted) syncPresenceLifecycle();
});

// throttle = the accelerator: gas revs it up, brake slows it, release coasts down SLOWLY
let throttle = 34; // 0..100 (starts ~50x)
const GAS = 52, BRAKE = 78, COAST = 6;
const game = { lev: niceLev(tToLev(throttle)), equity: 1 };
let lastLivePrice = 0;
let solSmooth = 0; // eased display price → a flowing minimap curve (raw price drives economics)

// price history (minimap), lateral steering, and the active round's entry
const priceHist: number[] = [];
// racer lateral drive (7H): carXTarget is the steering INTENT — pointer/keys write it,
// the Clown-Car lane-bet reads it (flip latency unchanged). `lane` is the BODY: the
// lane-drive PD+momentum state that replaced the old `carX += (target−carX)*0.18` spring.
let carXTarget = 0;
let lane: LaneState = { x: 0, vx: 0, yaw: 0, steer: 0 };
let prevRoadSpeed = 0;        // road speed last frame → the racer's squat/dive accel
const CAR_Z = -12;            // the racer car's fixed z — the road scrolls past it
const PARK_RECENTRE = 7.6;    // s⁻¹ target-recentre while parked (≈ the old 0.12-per-frame @60fps)
const ROAD_ACCEL_SCALE = 120; // road-speed delta (u/s²) that reads as FULL squat/dive — a full-throttle
                              // spool-up (~52 throttle/s) peaks around here, so launches pin the nose up
let roundStartMs = 0;
let roundMaxSec = 0; // this round's time cap, frozen at GO (Heavy Load runs longer than CONFIG.MAXSEC)
const round = { entryPx: 0, dir: 1 as 1 | -1 };
// frame-loop scratch (hot rAF path — zero per-frame allocation):
const _popNdc = new THREE.Vector3();   // coin-pop screen projection scratch

// asset switching (BTC/ETH/SOL) — blocked mid-bet; resets the chart for the new asset
hud.onAsset((a) => {
  if (opening || engine.getPhase() === "live") return; // locked while live AND while a GO is in flight (open reads `asset` after awaits)
  asset = a as "BTC" | "ETH" | "SOL";
  const selectedPrice = latestAssetPrices.get(asset) ?? null;
  priceSource.switchTo(selectedPrice);
  lastLivePrice = selectedPrice ?? 0;
  solSmooth = 0;
  priceHist.length = 0;
  hud.setActiveAsset(a);
});
hud.setActiveAsset(asset);

// hold anywhere on the open scene to DRIVE: press & hold = gas, drag left/right =
// steer, pull back (drag down) = brake, release = coast. HUD buttons capture their
// own taps (onTap), so this only fires on the road/scene behind the dock. The hold is
// bound to the finger that STARTED it (drivePointerId), so a second finger can tap HUD
// buttons mid-drive and its lift/move never drops the gas or yanks the steer anchor.
let holding = false, touchGas = false, touchBrake = false;
let drivePointerId: number | null = null;
let anchorX = 0, anchorY = 0, anchorCarX = 0;
canvas.addEventListener("pointerdown", (e) => {
  audio.resume(); radio.resume(); // unlock audio + start the radio on the first touch (any finger)
  if (drivePointerId !== null) return; // already driving with another finger — a second touch must not re-anchor
  if (mode === "highway" || (mode === "race" && engine.getPhase() !== "live") || mode === "garage") return;
  drivePointerId = e.pointerId; holding = true; touchGas = true; touchBrake = false;
  anchorX = e.clientX; anchorY = e.clientY; anchorCarX = carXTarget;
  joystick.show(e.clientX, e.clientY); // white ring at the thumb
});
// dropDrive fully lets go of the wheel (also used by the round-end resets below); releaseHold
// only lets the DRIVING finger do so — a button-tap finger lifting anywhere must not drop the gas.
const dropDrive = () => { drivePointerId = null; holding = false; touchGas = false; touchBrake = false; steerNorm = 0; joystick.hide(); };
const releaseHold = (e: PointerEvent) => { if (e.pointerId !== drivePointerId) return; dropDrive(); };
addEventListener("pointerup", releaseHold);
addEventListener("pointercancel", releaseHold);
addEventListener("pointermove", (e) => {
  if (e.pointerId !== drivePointerId) return; // only the driving finger steers; a second finger's move is ignored
  const dx = e.clientX - anchorX, dy = e.clientY - anchorY;
  joystick.move(dx, dy); // knob follows the drag
  // steer relative to where the thumb first landed (~32% of the width = full lock)
  carXTarget = Math.max(-10, Math.min(10, anchorCarX + (dx / (innerWidth * 0.32)) * 10));
  // scaled radial dead zone: ignore tiny drags, then ramp 0→1 smoothly (no snap) — lobby steer
  {
    const rawSteer = Math.max(-1, Math.min(1, dx / (innerWidth * 0.30)));
    const DZ = 0.05, mag = Math.abs(rawSteer);
    steerNorm = mag <= DZ ? 0 : Math.sign(rawSteer) * ((mag - DZ) / (1 - DZ));
  }
  // pulling back past a threshold brakes instead of accelerating
  touchBrake = dy > 55;
  touchGas = !touchBrake;
});

function assetForRoundFeed(feed?: string): "BTC" | "ETH" | "SOL" | null {
  if (!feed) return null;
  for (const key of Object.keys(CHAIN.FEEDS) as ("BTC" | "ETH" | "SOL")[]) {
    if (CHAIN.FEEDS[key].toBase58() === feed) return key;
  }
  return null;
}

function reconcileHighwaySnapshot(snap: RoundSnap): void {
  const dir = snap.dir === -1 ? -1 : 1;
  const restoredAsset = assetForRoundFeed(snap.feed);
  if (restoredAsset) {
    asset = restoredAsset;
    hud.setActiveAsset(asset);
  }
  highwayConfirmedLev = snap.lev;
  highwayControls.setConfirmed(snap.lev);
  game.lev = snap.lev;
  round.entryPx = snap.entryHuman;
  round.dir = dir;
  roundStartMs = snap.entryTs > 0 ? snap.entryTs * 1000 : Date.now();
  roundMaxSec = Number.POSITIVE_INFINITY;
  engine.launch({
    dir,
    lev: snap.lev,
    stake: snap.stake === undefined ? controls.playAmount() : baseToUnits(snap.stake),
    entryRaw: snap.entryHuman,
    banked: Number(snap.banked) / 1_000_000,
    startMs: roundStartMs,
    maxSec: Number.POSITIVE_INFINITY,
    borrowBpsPerDay: 1,
  });
  if (roundActive) advertiseHighwayPosition(dir, snap.lev);
}

function advertiseHighwayPosition(dir: 1 | -1, lev: number): void {
  if (mode !== "highway" || identity?.mode !== "privy" || !signedIn || simRound || !roundActive) return;
  const roundPda = deriveHighwayRoundPda(session.address());
  if (!roundPda) return;
  const laneSeed = seedHighwayMotion(roundPda, dir).lane;
  presence?.advertiseHighway({ asset, roundPda, dir, lev, laneSeed, carId: equippedCar.name });
}

function restoreHighwayPosition(): boolean {
  const snap = session.liveRound();
  if (!snap || !isHighwayRound(snap)) return false;
  const dir = snap.dir === -1 ? -1 : 1;
  if (mode !== "highway") {
    controls.setDir(dir);
    enterHighway(true);
  }
  reconcileHighwaySnapshot(snap);
  const roundPda = deriveHighwayRoundPda(session.address());
  highwayMotion = roundPda
    ? synchronizedHighwayMotion(roundPda, dir, snap.lev, Date.now() / 1000)
    : seedHighwayMotion(roundKey(snap, session.address()), dir);
  roundActive = true;
  simRound = false;
  nearDeath = false;
  deathsDoor.clear();
  autoExit.setLive(true);
  controls.setLive(true, "CASH OUT");
  garage.setBusy(true);
  upgrades.setBusy(true);
  walletUI.setBusy(true);
  highwayControls.show();
  highwayControls.setDisabled(false);
  hud.setOpenPosition(true);
  syncPresenceLifecycle();
  advertiseHighwayPosition(dir, snap.lev);
  hud.setStatus(session.crankArmed() ? "Position restored." : "Position restored. Auto protection needs rearming.");
  return true;
}

// Single sink for every ending — manual cash out, terminal-first flip/lever, and the crank poll.
// Freezes the local visual, sets the HUD outcome from the on-chain settled payload, fires FX, and
// refreshes the on-chain balance. Idempotent per round via `roundActive`.
function finalizeSettled(info: { outcome: number; outcomeName: string; payout: bigint; exitHuman: number }) {
  if (!roundActive) return;
  roundActive = false;
  tradeHistoryBridge.settle(info);
  presence?.clearHighway();
  const price = priceSource.price(), now = Date.now();
  if (engine.getPhase() === "live") engine.cashout(price, now); // freeze the visual at the live value
  const finalEq = engine.snapshot(price, now).equity;
  const liq = info.outcome === 2; // 0 cashout · 1 cap · 2 liq · 3 time
  const payoutUnits = baseToUnits(info.payout);
  nearDeath = false;
  if (liq) deathsDoor.kill(); else deathsDoor.clear(); // Skull: shatter on liq, stand down otherwise (no-op off-Skull)
  autoExit.setLive(false); // Pink Rod panel: unlock for the next round
  // reset UI
  dropDrive();
  throttle = 34; game.equity = 1; chase.setDriving(false);
  garage.setBusy(false); upgrades.setBusy(false); walletUI.setBusy(false);
  highwayControls.setDisabled(false);
  hud.setOpenPosition(false);
  hud.setTimer(effMaxSec(), false);
  controls.setLive(false, "GO!");
  hud.setMultiplier(Math.max(0, liq ? 0 : finalEq), liq ? "liquidated" : "settled");
  if (liq) {
    // Flintstone airbag: a liq can now carry a refund — show what the airbag saved.
    hud.setStatus(payoutUnits > 0
      ? `💥 Wrecked — airbag saved ${sol3(payoutUnits)}.`
      : "💥 Liquidated. Lost the play amount.");
    fx.liquidate(); audio.liquidate(); navigator.vibrate?.([30, 40, 30, 40, 90]);
  } else {
    // Slot Machine "Triple 7s": finishing a round (not liquidated) pulls the arm — 1-in-50
    // pays +777 coins. Soft-economy only; the real-SOL jackpot waits for VRF (crates first).
    const jackpot = ability === "slots" ? jackpotRoll(Math.random()) : 0;
    if (jackpot > 0) upgrades.addCoins(jackpot);
    hud.setStatus(
      (jackpot > 0 ? `🎰 TRIPLE 7s! +${jackpot} coins · ` : "") +
      `Settled at ×${finalEq.toFixed(2)}. Banked ${sol3(payoutUnits)}.`,
    );
    fx.confetti(); audio.cashout(); navigator.vibrate?.(jackpot > 0 ? [35, 60, 35, 60, 120] : 35);
  }
  // Settlement responses carry the authoritative play balance. Show it now; RPC is only a
  // background reconciliation path for delayed chain indexing or older settlement fallbacks.
  renderKnownBalance();
  void session.refreshBalance(session.delegated()).then(() => syncOnchainBalance()).catch(() => {});
  void syncTableCap(); // a settle moved money between player and till — re-clamp the bet cap
  // your run goes up in lights — the board leads with real settles over the demo feed
  stripBoard?.noteSettle({ tag: identity?.name ?? "you", mult: liq ? 0 : finalEq, sol: liq ? undefined : payoutUnits / 100 }); // only rounds settle here — worlds exist by then, but guard: settles fire off async chain polls
  // Settles keep you ON the track — the re-bet loop stays one GO away. The map pin (or
  // driving home via the lobby button) takes you back to the strip when you're done.
}

// ── guest practice rounds: the same race, zero money ────────────────────────
// The local engine IS the whole round (launch → tick liq/cap/time → settle), running off
// the live feed. No wallet, no chain, nothing at stake — the free test drive.
function launchPractice() {
  const price = priceSource.price();
  if (!(price > 0)) { hud.setStatus("Waiting for the price feed…"); return; }
  const dir = controls.dir();
  const lev = mode === "highway" ? highwayControls.value() : clampInt(game.lev, 10, 3000);
  roundMaxSec = mode === "highway" ? Number.POSITIVE_INFINITY : effMaxSec();
  simRound = true;
  round.entryPx = price;
  round.dir = dir;
  roundStartMs = Date.now();
  engine.launch({
    dir, lev, stake: controls.playAmount(), entryRaw: price, startMs: roundStartMs,
    maxSec: roundMaxSec, borrowBpsPerDay: mode === "highway" ? 1 : 0,
  });
  roundActive = true;
  nearDeath = false; deathsDoor.clear();
  if (mode === "highway") {
    highwayConfirmedLev = lev;
    highwayControls.setConfirmed(lev);
    highwayMotion = seedHighwayMotion(identity?.name ?? "practice", dir);
    game.lev = lev;
    hud.setOpenPosition(true);
  }
  else chase.setDriving(true);
  controls.setLive(true, "CASH OUT");
  garage.setBusy(true); upgrades.setBusy(true);
  hud.setStatus("Practice run — nothing at stake. Sign in to play for real SOL.");
}

function finalizePractice(snap: Snapshot) {
  if (!roundActive) return;
  roundActive = false;
  presence?.clearHighway();
  simRound = false;
  const liq = snap.reason === "liq";
  nearDeath = false;
  if (liq) deathsDoor.kill(); else deathsDoor.clear();
  autoExit.setLive(false);
  dropDrive();
  throttle = 34; game.equity = 1; chase.setDriving(false);
  garage.setBusy(false); upgrades.setBusy(false);
  highwayControls.setDisabled(false);
  hud.setOpenPosition(false);
  hud.setTimer(effMaxSec(), false);
  controls.setLive(false, "GO!");
  hud.setMultiplier(Math.max(0, liq ? 0 : snap.equity), liq ? "liquidated" : "settled");
  hud.setStatus(liq
    ? "💥 Practice wreck — no SOL lost. Sign in to play for real."
    : `Practice run settled at ×${snap.equity.toFixed(2)} — sign in to bank real SOL.`);
  if (liq) { fx.liquidate(); audio.liquidate(); navigator.vibrate?.([30, 40, 30, 40, 90]); }
  else { fx.confetti(); audio.cashout(); navigator.vibrate?.(35); }
  // practice runs hit the board too (that's the fun) — but never with a SOL figure
  stripBoard?.noteSettle({ tag: identity?.name ?? "guest", mult: liq ? 0 : snap.equity }); // guard: practice settles can fire async; worlds normally exist by settle time
}

// Authoritative on-chain close. On a confirmed close we finalize immediately; on an RPC hiccup we
// leave the round active so the crank/poll finalizes it (idempotent vs the crank).
async function closeRound(reason: "cashout" | "expire") {
  if (settling || !roundActive) return;
  if (simRound) { // practice: settle on the engine, never the chain
    finalizePractice(engine.cashout(priceSource.price(), Date.now()));
    void reason;
    return;
  }
  settling = true;
  dropDrive();
  if (mode === "highway") highwayControls.setDisabled(true);
  controls.setBusy("BAILING…"); // the big button shows the bail is in flight
  try {
    const res = await session.close();
    finalizeSettled(res);
  } catch {
    controls.setLive(true, "CASH OUT");
    hud.setStatus("Close didn't confirm — the round will settle shortly.");
    void reason;
  } finally {
    settling = false;
    highwayControls.setDisabled(false);
    controls.setBusy(null); // settle → finalizeSettled already set GO!; failure → repaint CASH OUT (round still live)
  }
}

// Session errors that carry their own player-facing message (surface verbatim, never retry —
// they describe a real state, not a hiccup): delegate busy / table limit / needs a deposit.
const FRIENDLY_CODES = new Set(["delegate_busy", "bankroll_full", "wallet_unfunded"]);

// A keyboard GO (Space/Enter) must respect the same guards the click path has: never launch off
// the track (lobby/showroom), nor behind an open shop/crate/garage/how-to overlay. Wiring the
// panels' isOpen() here is the check main.ts was previously missing entirely.
controls.setKeyLaunchBlocked(() =>
  mode === "lobby" || mode === "garage" || mode === "grandprix" ||
  upgrades.isOpen() || garage.isOpen() || crateBox.isOpen() || howto.isOpen() || tradeHistory.isOpen(),
);

controls.onLaunch(async () => {
  // GO launches from the strip too — but never behind an open panel (garage menu or upgrades
  // shop over the world; Space/Enter would otherwise start a round invisibly behind it)
  // the strip has no betting UI — GO lives on the track (Space in the lot must not launch)
  if (mode === "lobby" || mode === "garage" || mode === "grandprix") return; // no launching from the strip, showroom, or an in-app race
  audio.resume(); radio.resume();
  if (opening || settling || roundActive || engine.getPhase() === "live") return; // re-entrancy
  if (!identity) { showIdentityGate(); return; } // no driver yet → the gate is the front door
  // Guests race in PRACTICE mode: the round runs entirely on the local engine off the live
  // feed — no wallet, no chain, no SOL. Sign-in upgrades the same GO to real money.
  if (identity.mode === "guest") { launchPractice(); return; }
  // Real-money rounds must never open on a simulated or frozen price. price() returns the sim
  // drift indistinguishably from a real tick, so gate the money GO on live() (a real, fresh tick)
  // — not price() > 0. Guests keep racing the sim above; only this signed-in path is gated.
  if (!priceSource.live()) { hud.setStatus("Waiting for the live price feed…"); return; }
  opening = true;
  controls.setBusy("LAUNCHING…"); // the big button reads the launch state (a status line is invisible on the phone)
  if (mode === "highway") highwayControls.setDisabled(true);
  // The round opens on whatever asset the BTC/ETH/SOL tabs have selected; the registry binds the
  // round to that asset's feed and `hud.onAsset` blocks switching once live, so the local engine's ×
  // (driven off priceSource for `asset`) reads the same feed the chain settles against.
  try {
    // Not signed in yet? This is where the wallet connects (Privy opens its login modal here).
    if (!(await ensureSignedIn())) return;
    if (roundActive) return; // ensureSignedIn may have restored an existing Highway position
    // First GO auto-starts the ER session (buy-in if empty + slice the bankroll + delegate).
    let playAmount = controls.playAmount(); // 0.01-SOL units — sizes the house slice for the round
    hud.setStatus("Getting on track…");
    try {
      // Devnet transients (RPC/ER hiccup, confirm flake) fail a press that would succeed if
      // pressed again — so press again ourselves: one silent retry before surfacing anything.
      // ensureSession is re-entrant by design (it's exactly what the next GO would run).
      for (let attempt = 0; ; attempt++) {
        try {
          // bankroll_full here = the pot can't host THIS stake. The stepper cap makes that
          // nearly impossible to dial up, but another table can carve the pot between the cap
          // poll and this press — so clamp to the fresh limit and play that, never error.
          for (let clamped = false; ; clamped = true) {
            try {
              // buy in at least the bet: a Heavy-Load bet can exceed the standard 0.1 SOL buy-in
              await session.ensureSession(Math.max(BUY_IN_BASE, unitsToBase(playAmount)), unitsToBase(playAmount));
              break;
            } catch (e: any) {
              if (e?.code !== "bankroll_full" || clamped) throw e;
              await syncTableCap(); // pulls the stepper (and the visible bet label) down with it
              const lower = controls.playAmount();
              if (!(lower < playAmount) || tablePlayCap < 1) throw e; // nothing to clamp to → named backstop
              playAmount = lower;
              hud.setStatus(`Table's a little light — playing ${sol3(playAmount)} this round.`);
            }
          }
          break;
        } catch (e: any) {
          if (attempt > 0 || FRIENDLY_CODES.has(e?.code)) throw e; // named states surface immediately
          console.warn("session start hiccup — retrying once:", e);
          hud.setStatus("Rough patch — retrying…");
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    } catch (e: any) {
      console.error("session start failed", e); // the open() catch logs too — keep this path debuggable
      const friendly = FRIENDLY_CODES.has(e?.code);
      hud.setStatus(friendly ? e.message : "Couldn't start the round. Try again.");
      if (e?.code === "wallet_unfunded") walletUI.open(); // show the deposit address right away
      // A buy-in may have landed before the failure (e.g. bought in, then the bankroll slice
      // was refused) — refresh so the chip shows the money that DID move into the play balance.
      void session.refreshBalance(false).then(() => syncOnchainBalance()).catch(() => {});
      return;
    }
    // NOTE: no refreshBalance(true) here — ensureSession just computed the authoritative
    // balance (with a stale-ER-clone guard); a bare ER re-read can serve a stale 0 and
    // bounce a funded player ("Not enough SOL" — live-hit).
    syncOnchainBalance();

    if (session.balance() < BigInt(unitsToBase(playAmount))) {
      hud.setStatus("Not enough SOL for this bet — send SOL to your wallet first.");
      walletUI.open();
      return;
    }
    const dir = controls.dir();
    // Highway: you pull onto the road from a stop — open in bottom gear (10×); the ladder
    // takes it from there. Racer: the throttle's live leverage, on-chain RMAX=3000.
    const lev = mode === "highway" ? highwayControls.value() : clampInt(game.lev, 10, 3000);
    roundMaxSec = mode === "highway" ? Number.POSITIVE_INFINITY : effMaxSec();
    const openDuration = mode === "highway" ? HIGHWAY_DURATION_SENTINEL : roundMaxSec;
    hud.setStatus("Launching…");
    // liq floor in on-chain SCALE units (1e6): CONFIG.LIQ is 0.20 by default and drops toward
    // 0.10 as the Suspension upgrade is bought. The program clamps to [100_000, 200_000] and
    // stamps it on the round, so settlement liquidates at the player's own upgraded floor.
    // Skull "Death's Door": pass a 2s on-chain liq-grace so the crank holds a sub-floor
    // dip for 2s (the Death's-Door animation) instead of liquidating on the first breach —
    // recover within the window and you survive. Every other car passes 0 (immediate liq).
    // Pink Rod "Auto-Exit": the panel's stop-loss / take-profit thresholds (SCALE units,
    // 0 = OFF) — the crank auto-cashes-out when equity crosses one. Other cars send 0/0.
    const graceSecs = ability === "skull" ? 2 : 0;
    const { slFp, tpFp } = ability === "pinkRod" ? autoExit.values() : { slFp: 0, tpFp: 0 };
    // Flintstone "Stone-Age Airbag": a liquidation refunds min(20%, wreck equity) of the
    // stake — settled on-chain like a forced cash-out at that equity (standard edge applies).
    const refundFp = ability === "airbag" ? 200_000 : 0;
    let opened;
    // One GO = one launch even when this session's house pot is spent. A 6005 open
    // (HouseUndercapitalized: a hot streak drained the till below this round's lock) is
    // the state the NEXT GO would recover from anyway — so rebuild the table under the
    // hood (sweep the spent till into the master pot, carve a fresh one, redelegate) and
    // retry the open ONCE in this same press. The player never manages sessions; only a
    // rebuild that itself fails, or a second 6005, surfaces a message — a NAMED one.
    for (let rebuilt = false, retried = false; ; ) {
      try {
        opened = await session.open(asset, dir, lev, unitsToBase(playAmount), openDuration, Math.round(CONFIG.LIQ * 1_000_000), graceSecs, slFp, tpFp, refundFp);
        break;
      } catch (e: any) {
        console.error("on-chain open failed", e);
        // HouseUndercapitalized is RaiderError #6005 — the on-chain error arrives as the raw
        // custom code ({"Custom":6005}), not the name, so match both.
        const emsg = String(e?.message ?? "");
        const drained = emsg.includes("HouseUndercapitalized") || emsg.includes("6005");
        if (drained && !rebuilt) {
          rebuilt = true;
          hud.setStatus("Hot streak — pulling up a fresh table…");
          try {
            await session.endSession();
            await session.ensureSession(Math.max(BUY_IN_BASE, unitsToBase(playAmount)), unitsToBase(playAmount));
            syncOnchainBalance();
            hud.setStatus("Launching…");
            continue;
          } catch (re: any) {
            console.error("table rebuild failed", re);
            const friendly = FRIENDLY_CODES.has(re?.code);
            hud.setStatus(friendly ? re.message : "Couldn't start the round. Try again.");
            if (re?.code === "wallet_unfunded") walletUI.open();
          }
        } else if (drained) {
          // a fresh till AND still 6005: the carve race for the last of the pot was lost —
          // ensureSession's adaptive sizing would otherwise have named a table limit.
          try { await session.endSession(); } catch (err) { console.warn("teardown after spent pot failed:", err); }
          hud.setStatus("The table's bankroll is spent — try a smaller bet.");
        } else if (!retried) {
          // transient (RPC/ER hiccup): open() reconciles any stale round on entry, so an
          // immediate second attempt is exactly what "press GO again" would do — do it here.
          retried = true;
          hud.setStatus("Rough patch — retrying…");
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        } else {
          hud.setStatus("Couldn't start the round. Try again.");
        }
        syncOnchainBalance();
        controls.setLive(false, "GO!");
        return;
      }
    }
    tradeHistoryBridge.begin({
      asset,
      dir,
      lev,
      stakeBase: unitsToBase(playAmount),
      entryPrice: opened.entryHuman,
      entryTs: opened.entryTs,
    });
    round.entryPx = opened.entryHuman; // human entry price (NOT the raw mantissa)
    round.dir = dir;
    roundStartMs = Date.now();
    engine.launch({
      dir, lev, stake: playAmount, entryRaw: opened.entryHuman, startMs: roundStartMs,
      maxSec: roundMaxSec, borrowBpsPerDay: mode === "highway" ? 1 : 0,
    });
    roundActive = true;
    nearDeath = false; deathsDoor.clear(); // fresh round → drop any lingering Skull near-death state
    autoExit.setLive(true); // Pink Rod panel: armed + locked (values stamped on-chain at open)
    if (mode === "highway") {
      highwayConfirmedLev = lev;
      highwayControls.setConfirmed(lev);
      const roundPda = deriveHighwayRoundPda(session.address());
      highwayMotion = roundPda
        ? synchronizedHighwayMotion(roundPda, dir, lev, Date.now() / 1000)
        : seedHighwayMotion(roundKey({ deadlineTs: opened.deadlineTs }, session.address()), dir);
      game.lev = lev;
      hud.setOpenPosition(true);
      syncPresenceLifecycle();
      advertiseHighwayPosition(dir, lev);
    } else {
      chase.setDriving(true);
    }
    controls.setLive(true, "CASH OUT");
    garage.setBusy(true); upgrades.setBusy(true); walletUI.setBusy(true);
    hud.setStatus(session.crankArmed() ? "" : mode === "highway"
      ? "⚠ Auto protection is off. Keep the app open or tap CASH OUT."
      : "⚠ Auto cash-out is off this round. Tap CASH OUT before the timer ends.");
  } finally {
    opening = false;
    highwayControls.setDisabled(false);
    controls.setBusy(null); // round live → repaint BAIL; an early-return failure → repaint GO! (the error status stays)
  }
});

controls.onCashout(() => {
  if (!roundActive || settling) return;
  void closeRound("cashout");
});

// Lane-bet flips fire an on-chain flip() in the background (instant local feel above). A terminal-first
// flip settles the round via finalizeSettled; single-flight via `flipping` so a held lane can't spam txs.
let flipping = false;
async function doFlip(dir: 1 | -1) {
  if (flipping || !roundActive) return;
  if (simRound) return; // practice: the engine's setDir already flipped — no chain to mirror
  flipping = true;
  try {
    const res = await session.flip(dir);
    if (res.settled) { finalizeSettled(res); return; }
    // The flip landed but re-anchored to a direction that disagrees with our optimistic one →
    // the confirmed chain read wins (reconcile back to it).
    applyFlipReconcile(dir, { status: 1, dir: res.dir, entryHuman: res.entryHuman });
  } catch {
    // The on-chain flip did NOT land — the optimistic local flip is now ahead of the chain. Snap the
    // HUD/engine back to the confirmed chain direction so we never show a position the chain doesn't
    // hold (best-effort: if the read also fails there's nothing to revert to, and close()/the crank
    // still settle at on-chain truth).
    const snap = await session.poll().catch(() => null);
    applyFlipReconcile(dir, snap);
  } finally {
    flipping = false;
  }
}
// Desired-vs-confirmed: when the confirmed chain read disagrees with the optimistic flip, revert the
// local dir + entry to the chain's — otherwise the HUD (and liq line) show a position the chain never took.
function applyFlipReconcile(optimisticDir: 1 | -1, confirmed: { status: number; dir: number; entryHuman: number } | null) {
  const fix = reconcileFlip(optimisticDir, confirmed);
  if (!fix || !roundActive) return;
  engine.setDir(fix.dir, fix.entryPx); // re-anchor the engine to the chain's dir + entry
  round.dir = fix.dir;
  round.entryPx = fix.entryPx;
  controls.setDir(fix.dir);
  hud.setStatus(`Flip didn't take — back to ${fix.dir === 1 ? "LONG" : "SHORT"}.`);
}

// One price update per frame, shared by the race and highway branches: eases the display
// price, feeds the HUD + minimap history, and returns the settle-safe round price
// (spec §9: never settle P&L on a stale feed).
function samplePrice(): number {
  const price = priceSource.price();
  const live = priceSource.live();
  if (live && price > 0) lastLivePrice = price;
  if (price > 0) solSmooth = solSmooth ? solSmooth + (price - solSmooth) * 0.1 : price;
  hud.setPrice(solSmooth || price, live);
  if (solSmooth > 0) { priceHist.push(solSmooth); if (priceHist.length > 300) priceHist.shift(); }
  return live ? price : lastLivePrice || price;
}

// step the shared body pose from freedrive's DriveState: derive longitudinal accel from
// the speed delta, then feed core/body-language with the mode's tune (lobby + highway;
// the racer derives its accel from the scrolling road speed instead — see the race branch)
function stepFreedriveBody(tune: DriveTune, dt: number) {
  const accel = dt > 0 ? (drive.speed - prevDriveSpeed) / dt : 0;
  prevDriveSpeed = drive.speed;
  body = stepBody(body, drive.steer / tune.MAX_STEER_LOW, Math.min(1, Math.abs(drive.speed) / tune.MAX_FWD), accel, tune.ACCEL, dt);
}

// Timestamp of the last frame we actually rendered — the low tier's 30fps cap measures against
// it. High tier leaves quality.frameCapFps undefined, so the gate below never fires there.
let lastRenderMs = 0;
function frame(now: number) {
  // Low-tier frame cap: when too little wall-clock has elapsed since the last *rendered* frame,
  // reschedule and bail BEFORE any work. Placed above fpsMeter.tick (so the chip reports the real
  // presented rate, not the offered rAF rate) and above getDelta() (so the clock delta accumulates
  // across the skipped frames — dt then reflects true inter-render time, clamped to 0.05 below).
  // Safe to skip whole frames because the sim steps on dt everywhere (throttle/lane/world/body all
  // integrate dt; the recentre is explicitly fps-independent), so 30Hz stepping matches 60Hz.
  if (!shouldRenderFrame(lastRenderMs, now, quality.frameCapFps)) {
    requestAnimationFrame(frame);
    return;
  }
  lastRenderMs = now;
  fpsMeter.tick(now); // rAF timestamp — every mode path funnels through here
  const dt = Math.min(0.05, ctx.clock.getDelta()); // clamp so a frame hitch can't teleport the world
  updateEmoteVisual(localEmoteVisual, dt);

  if (mode === "home") { requestAnimationFrame(frame); return; } // no 3D render while home is up

  if (mode === "grandprix") {
    raceGame?.update(dt); // the race owns its sim; a no-op once disposed (guards the trailing frame)
    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }

  if (mode === "lobby") {
    // touch (hold + drag) OR keyboard (W/↑ gas, S/↓ brake, A/D ←→ steer) — shared with the road
    const kSteer = controls.steer();
    const gas = holding || controls.gas();
    const brake = touchBrake || controls.brake();
    // named driveThrottle: the module-level `throttle` is the RACE rev (feeds the strip's
    // idle tach below) — shadowing it here once burned the gauge down to the 10× floor
    const driveThrottle = brake ? -1 : gas ? 1 : 0;
    const steer = Math.max(-1, Math.min(1, (holding ? steerNorm : 0) + kSteer));
    drive = driveStep(drive, { throttle: driveThrottle, steer }, dt, LOT_BOUNDS);
    stepFreedriveBody(DRIVE, dt);

    car.update(dt, drive.speed);
    car.setEquity("idle", 1);
    car.group.position.set(drive.x, 0, drive.z);
    // -heading: Three's +Y rotation mirrors X vs the physics/camera (sin,-cos) convention,
    // so the body must use -heading to actually face the way it drives (camera stays behind it)
    car.group.rotation.set(body.pitch, -drive.heading, body.roll);
    car.setSteer(drive.steer / DRIVE.MAX_STEER_LOW); // front wheels point to the real steer angle
    try {
      presence?.updatePose({
        x: drive.x,
        z: drive.z,
        heading: -drive.heading,
        speed: Math.abs(drive.speed),
        carId: equippedCar.name,
      });
    } catch {
      // Presence is visual-only and cannot interrupt the local frame loop.
    }

    // doors freeze while a GO is in flight (or a round is somehow active): parking into the
    // garage mid-launch would open an overlay over a race that starts behind it
    const hit = opening || roundActive ? null : entranceHit(drive.x, drive.z);
    lobby!.setActiveDoor(doorArmed ? hit : null); // non-null: "lobby" mode is only entered via enterLobby(), which ran ensureWorlds()
    lobbyHud.setPrompt(doorArmed ? hit : null);
    if (doorArmed && hit) {
      doorDwell += dt;
      lobbyHud.setProgress(doorDwell / DOOR_DWELL_S);
      if (doorDwell > DOOR_DWELL_S) { doorDwell = 0; doorArmed = false; triggerBuilding(hit); }
    } else {
      doorDwell = 0;
      if (!hit) doorArmed = true; // re-arm once the car has cleared every doorway
    }

    // the strip is the betting stage: keep the price chip + chart history + idle tach/timer
    // live exactly like race idle, so GO is fully informed without ever leaving the plaza
    samplePrice();
    game.lev = clampInt(niceLev(tToLev(throttle, effRmax())), 10, 3000);
    tach.setThrottle(throttle / 100, game.lev);
    hud.setTimer(effMaxSec(), false);
    minimap.draw({ hist: priceHist, inRun: false, equity: game.equity, entryPx: round.entryPx, liqPx: 0, dir: round.dir });

    lobby!.update(dt);        // non-null throughout this "lobby" branch: entered via enterLobby() → ensureWorlds()
    stripBoard!.update(dt); // jumbotron cycles its action feed
    cruisers!.update(dt);   // ambient laps around the plaza
    if (quality.detail === "reduced") {
      // low tier: far-side dressing is sub-pixel on a phone but still the heaviest draws in
      // the square — hide whole car anchors beyond the lot-scaled radius (no alloc, roots only)
      stripCars!.cull(drive.x, drive.z, DRESSING_CULL_D);
      cruisers!.cull(drive.x, drive.z, DRESSING_CULL_D);
    }
    lobbyCam!.update(ctx.camera, dt, drive.x, drive.z, drive.heading);

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }

  if (mode === "highway") {
    const roundPrice = samplePrice();
    const nowMs = Date.now();

    if (!highwayMotion) {
      highwayMotion = seedHighwayMotion(session.address() || identity?.name || "practice", round.dir);
    }
    highwayMotion = stepHighwayMotion(highwayMotion, highwayConfirmedLev, dt);
    const pose = highwayPose(highwayMotion);
    const autoSpeed = speedForLeverage(highwayConfirmedLev);
    drive = { x: pose.x, z: pose.z, heading: pose.heading, speed: autoSpeed, steer: 0 };

    const yHere = elevationAt(highwayMotion.s);
    const yAhead = elevationAt(highwayMotion.s + highwayMotion.dir * SLOPE_SAMPLE);
    const yBehind = elevationAt(highwayMotion.s - highwayMotion.dir * SLOPE_SAMPLE);
    const slopePitch = Math.max(-SLOPE_CLAMP, Math.min(SLOPE_CLAMP, Math.atan2(yAhead - yBehind, 2 * SLOPE_SAMPLE)));
    body = { roll: body.roll * Math.exp(-5 * dt), pitch: body.pitch * Math.exp(-5 * dt) };
    car.update(dt, autoSpeed);
    car.group.position.set(pose.x, yHere, pose.z);
    car.group.rotation.set(slopePitch + body.pitch, -pose.heading, body.roll);
    car.setSteer(0);

    // trackside billboard: the same feed the round settles against, made physical
    hwBillboardCd -= dt;
    if (hwBillboardCd <= 0) {
      hwBillboardCd = 0.5;
      const px = solSmooth || roundPrice;
      oval!.setBillboard(asset, px > 0 ? px.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"); // non-null: "highway" mode is entered via enterHighway() → ensureWorlds()
    }

    const speedFrac = autoSpeed / speedForLeverage(HIGHWAY_MAX_LEV);
    tach.setThrottle(speedFrac, highwayConfirmedLev);
    audio.engine(speedFrac, true);

    if (engine.getPhase() === "live") {
      hud.setOpenPosition(true);
      const snap = simRound ? engine.tick(roundPrice, nowMs) : engine.snapshot(roundPrice, nowMs);
      if (snap.phase !== "live") {
        if (simRound) finalizePractice(snap);
      } else {
        game.equity = snap.equity;
        hud.setMultiplier(Math.max(0, snap.equity), "live");
        controls.setBuffer(Math.max(0, Math.min(1, snap.buffer)));
        controls.setLive(true, `${snap.equity >= 1 ? "CASH OUT" : "BAIL"} ${sol3(snap.payout)}`, snap.equity < 1);
        hud.setTimer(0, true);
        car.setEquity("live", Math.max(0, snap.equity));
      }
    } else {
      car.setEquity("idle", 1);
      hud.setOpenPosition(false);
      hud.setTimer(effMaxSec(), false);
    }

    const liqPx = engine.getPhase() === "live" ? liqPriceOf(round.entryPx, round.dir, highwayConfirmedLev, CONFIG.LIQ) : 0;
    minimap.draw({ hist: priceHist, inRun: engine.getPhase() === "live", equity: game.equity, entryPx: round.entryPx, liqPx, dir: round.dir });

    oval!.update(dt);
    const verifiedRemoteStates = verifiedHighwayCars.map((remote) => {
      remote.motion = stepHighwayMotion(remote.motion, remote.lev, dt);
      const remotePose = highwayPose(remote.motion);
      return { id: remote.id, x: remotePose.x, z: remotePose.z, heading: remotePose.heading, dir: remote.dir };
    });
    oval!.setRemoteCars(
      ((window as any).__hwGhostStates as import("./render/oval").OvalRemoteCar[] | undefined)
      ?? verifiedRemoteStates,
    );
    lobbyCam!.update(ctx.camera, dt, pose.x, pose.z, pose.heading, yHere); // non-null: highway → ensureWorlds()

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }

  if (mode === "garage") {
    garageEnterT += dt;
    garageRoom?.update(dt); // spin the turntable, breathe the neon

    // showroom camera: ease a push-in, then hold the hero angle with a slow drift. Framing is
    // orientation-aware — portrait (the mobile game) frames the car in the upper third for the
    // bottom-sheet menu; landscape sits it left of centre for the right-side panel.
    const ease = 1 - Math.pow(1 - Math.min(1, garageEnterT / 1.8), 3); // easeOutCubic
    const sway = Math.sin(garageEnterT * 0.32) * 0.6; // gentle idle life
    if (ctx.camera.aspect < 0.9) {
      // PORTRAIT (mobile): near head-on 3/4 aimed BELOW the car so it rides big in the top half —
      // the bottom-sheet menu owns the lower ~2/3, so the hero car crowns it instead of hiding.
      const ang = -0.32;
      const dist = 19 - ease * 4.5;          // 19 → 14.5 push-in
      const h = 5.2 - ease * 1.6;            // 5.2 → 3.6 drop to a low hero angle
      ctx.camera.position.set(Math.sin(ang) * dist + sway, h, Math.cos(ang) * dist);
      ctx.camera.lookAt(0, -2.7, 0);
    } else {
      // LANDSCAPE: car a touch left of centre so the right-side panel doesn't cover it
      const ang = -0.5;
      const dist = 30 - ease * 11;           // 30 → 19
      const h = 12 - ease * 4.6;             // 12 → 7.4
      ctx.camera.position.set(Math.sin(ang) * dist + sway - 3.2, h, Math.cos(ang) * dist + 3);
      ctx.camera.lookAt(-2.4, 2.1, 0);
    }

    // let the reveal play, THEN slide the collection menu in over the (translucent) room
    if (!garageMenuShown && garageEnterT > 1.7) {
      garageMenuShown = true;
      garage.setShowroom(true);
      garage.openGarage();
    }

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }

  const roundPrice = samplePrice();
  const drivable = engine.getPhase() === "live"; // you can only drive while a round is live

  // accelerator with momentum — only while playing; the showroom car stays parked
  const gasOn = drivable && (controls.gas() || touchGas);
  const brakeOn = drivable && (controls.brake() || touchBrake);
  if (drivable) {
    if (gasOn) throttle += GAS * dt;
    else if (brakeOn) throttle -= BRAKE * dt;
    else throttle -= COAST * dt;
    throttle = Math.max(0, Math.min(100, throttle));
  }
  const boost = nitro.update(dt, drivable); // Orion Nitro Overdrive: 2× for 3s, else 1
  const frozen = flux.update(dt, drivable); // DeLorean Flux Brake: P&L pinned at 10× for ~4s
  pickups.setMagnet(magnet.update(dt, drivable)); // Magnet: coins curve in only during the ~4s burst
  barrelRoll.update(drivable);              // Helmet: keep the FLIP button live + re-arm between rounds
  game.lev = frozen ? FLUX_LEV : clampInt(niceLev(tToLev(throttle, effRmax())) * boost, 10, 3000); // car base (≤1500) × nitro (2×), on-chain RMAX=3000
  tach.setThrottle(frozen ? 0 : Math.min(1, (throttle / 100) * boost), game.lev); // needle pegs during nitro, drops to idle while flux-frozen
  audio.engine(throttle / 100, gasOn || drivable); // rev drone tracks leverage (live only)
  if (drivable) { engine.setLeverage(game.lev, roundPrice); if (!simRound) session.noteLeverage(game.lev); } // instant local (+ coalesced on-chain lever — practice never touches the chain)

  if (engine.getPhase() === "live") {
    const nowMs = Date.now();
    // The smooth ×, payout and liq-buffer are the LOCAL engine off the live feed (no server mark).
    // Real rounds: the on-chain Round is the money truth (crank poll + authoritative close()).
    // Practice rounds: the engine IS the truth — tick() liquidates/caps/times out right here.
    const snap = simRound ? engine.tick(roundPrice, nowMs) : engine.snapshot(roundPrice, nowMs);
    if (snap.phase !== "live") {
      if (simRound) finalizePractice(snap);
    } else {
      game.equity = snap.equity;
      hud.setMultiplier(Math.max(0, snap.equity), "live");
      controls.setBuffer(Math.max(0, Math.min(1, snap.buffer)));
      // Skull "Death's Door": arm as equity nears the liq floor, disarm once clearly recovered.
      if (ability === "skull") {
        if (!nearDeath && snap.buffer <= 0.10) nearDeath = true;
        else if (nearDeath && snap.buffer >= 0.22) nearDeath = false;
        deathsDoor.danger(nearDeath);
      }
      hud.setTimer(roundMaxSec - (nowMs - roundStartMs) / 1000, true);
      car.setEquity("live", Math.max(0, snap.equity));
      controls.setLive(true, `${snap.equity >= 1 ? "CASH OUT" : "BAIL"} ${sol3(snap.payout)}`, snap.equity < 1);
      // Local time-cap backstop: the native crank normally settles first; this closes on-chain if it lags.
      if (roundActive && !settling && (nowMs - roundStartMs) / 1000 >= roundMaxSec) void closeRound("expire");
    }
  } else {
    car.setEquity("idle", 1);
    hud.setTimer(effMaxSec(), false);
  }

  // lateral steering — only while playing; the parked car re-centres in the showroom
  if (drivable) {
    carXTarget += controls.steer() * 22 * dt;
    carXTarget = Math.max(-10, Math.min(10, carXTarget));
    // Clown Car ability: your lane IS the bet — left (green) = LONG, right (red) = SHORT.
    // Steering across the centre flips the live position (realizes P&L + re-anchors).
    if (ability === "laneBet") {
      const laneDir: 0 | 1 | -1 = carXTarget < -0.6 ? 1 : carXTarget > 0.6 ? -1 : 0;
      if (laneDir !== 0) {
        if (laneDir !== round.dir && !flipping) {
          engine.setDir(laneDir, roundPrice);    // instant local flip (feel)
          round.dir = laneDir;
          round.entryPx = roundPrice;             // re-anchor the local liq line
          void doFlip(laneDir);                   // mirror to the on-chain round in the background
        }
        controls.setDir(laneDir);
      }
    }
  } else {
    carXTarget += (0 - carXTarget) * (1 - Math.exp(-PARK_RECENTRE * dt)); // ease back to centre while parked (fps-independent)
  }

  const live2 = drivable;
  const speed = roadSpeed(throttle / 100, game.equity, live2) * boost; // Nitro: road rips by 2× faster
  // lane-drive physics (7H): PD-with-momentum chases the target; the accel budget scales
  // with road speed (flat-out darts, idle is lazy). Parked pins speedFrac to 0 — the road
  // still scrolls in the showroom, so raw speed never reads 0 — and AUTH_MIN recentres.
  const speedFrac = drivable ? Math.min(1, speed / ROAD_SPEED_MAX) : 0;
  const previousLaneX = lane.x;
  lane = laneStep(lane, carXTarget, speedFrac, dt);
  const w = world!; // non-null: this "race" branch is only reached in mode==="race", entered solely via exitLobby() → ensureWorlds()
  w.update(dt, speed, 0);

  // car hugs the road: ride the surface height + pitch to the local slope, lean into turns
  const carY = w.surfaceY(CAR_Z);
  const aheadY = w.surfaceY(CAR_Z - SLOPE_SAMPLE), behindY = w.surfaceY(CAR_Z + SLOPE_SAMPLE);
  car.update(dt, speed);
  car.group.position.x = lane.x;
  car.group.position.y = carY;
  // squat/dive from the road-speed delta (a nitro kick reads as a nose-up lunge)
  const accel = dt > 0 ? (speed - prevRoadSpeed) / dt : 0;
  prevRoadSpeed = speed;
  body = stepBody(body, lane.steer, speedFrac, accel, ROAD_ACCEL_SCALE, dt);
  const slopePitch = Math.max(-SLOPE_CLAMP, Math.min(SLOPE_CLAMP, Math.atan2(aheadY - behindY, 2 * SLOPE_SAMPLE)));
  // steer like a real car: the nose yaws with the ACTUAL lateral velocity (momentum you
  // can see), the front wheels show the PD demand — pinned into a swerve, then flipped
  // against it to arrest the slide — and the body banks/squats over the road slope.
  // YXZ order keeps pitch/roll body-local under the yaw (see the boot-time note).
  car.group.rotation.x = slopePitch + body.pitch;
  // negated like the lobby's -drive.heading: the mesh noses -Z, so positive rotation.y
  // swings the nose toward -X — physics-positive (rightward) lean needs the flip, or the
  // tail leads every lane change and the car reads rear-heavy
  car.group.rotation.y = -lane.yaw;
  car.group.rotation.z = body.roll;
  car.setSteer(lane.steer);

  // camera: idle showroom orbit when parked, smooth blend to the chase cam while driving
  chase.update(ctx.camera, dt, speed, carY, lane.x);
  // Helmet barrel roll: flip the whole level 180° about the view axis and hold it inverted
  // until the round ends. Composes on the chase cam's lookAt; 0 while level (other cars untouched).
  const wfRoll = worldFlip.update(dt, drivable);
  if (wfRoll !== 0) ctx.camera.rotateZ(wfRoll);

  fireTrail.update(dt, speed, frozen, lane.x, CAR_Z, w.surfaceY); // flux time-jump: burning wheel traces

  // collectible coins: cosmetic only — they must NOT affect P&L, or every
  // round becomes a guaranteed win and the long/short bet stops mattering
  const hit = pickups.update(dt, speed, lane.x, w.surfaceY, drivable, {
    previousX: previousLaneX,
    yaw: car.group.rotation.y,
    z: CAR_Z,
  });
  if (hit.count > 0) {
    upgrades.addCoins(hit.value); // value carries Vaporwave's ×2/×3/×5; refreshes the counter
    audio.coin(hit.count);
    if (hit.pops.length) {
      // project a point just above the car to screen space so the ×N rises over IT
      const ndc = _popNdc.set(lane.x, carY + 3.5, CAR_Z).project(ctx.camera);
      const sx = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
      hit.pops.forEach((m, k) => fx.coinPop(m, sx + (k - (hit.pops.length - 1) / 2) * 34, sy)); // stagger multiples
    }
  }
  if (hit.scrap > 0) {
    upgrades.addScrap(hit.scrap); // banked to the garage save → refreshes the scrap chip
    audio.coin(hit.scrap);        // reuse the pickup chime for now (a distinct clank can come later)
  }

  // minimap: live SOL price line with entry/liq overlays
  const liqPx = live2 ? liqPriceOf(round.entryPx, round.dir, game.lev, CONFIG.LIQ) : 0;
  minimap.draw({ hist: priceHist, inRun: live2, equity: game.equity, entryPx: round.entryPx, liqPx, dir: round.dir });

  if (post) post.render();
  else ctx.renderer.render(ctx.scene, ctx.camera);
  requestAnimationFrame(frame);
}
// Poll the on-chain Round ~1.5×/s so a crank/keeper settlement surfaces even if the player never taps.
// setInterval (not rAF) because rAF is throttled hard in Claude Preview.
let polling = false;
setInterval(async () => {
  if (!roundActive || settling || polling || !session.delegated()) return;
  polling = true;
  try {
    const snap = await session.poll();
    if (snap && snap.status === 2) finalizeSettled(snap);
    else if (snap && mode === "highway" && isHighwayRound(snap)) reconcileHighwaySnapshot(snap);
  } catch { /* transient RPC — keep last */ }
  finally { polling = false; }
}, 650);

// Boot into the Slopwheels collection: the card grid IS the intro screen now (no 3D render behind it,
// and no 3D world built — ensureWorlds() defers all of that to the first entry FROM home). The lobby/
// track are reached FROM home — [Drive lobby] on a card lands in the 3D strip. Shader warming (the old
// boot-time precompileModes() call) now rides that first ensureWorlds(), since nothing 3D exists yet.
// DEV-ONLY bake-harness hook: scripts/bake-cards.mjs drives the lobby's Garage to render card art, but
// home now covers that chrome. `?nohome=1` (dev builds only — stripped from prod) boots straight to the
// lobby and dismisses the splash so the baker can reach the hamburger → Garage.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("nohome")) {
  enterLobby(); // self-ensures worlds (ensureWorlds() at its top) before the baker touches the 3D lobby
  (window as Window & { hideSplash?: () => void }).hideSplash?.(); // no home path to dismiss the splash here
} else {
  enterHome();
}
// The identity gate over the strip — the game's whole login screen. Shows on first
// launch and after every log-out. Two doors:
//   RIDE AS GUEST (name required) → practice mode: engine-only rounds, no wallet, ever.
//   SIGN IN (name optional)       → Privy (email/social); no name typed → one is derived
//                                   from the wallet address. Real SOL from then on.
identity = loadIdentity();
syncPresenceLifecycle();
// First-login welcome gift: only a brand-new browser (no identity yet) is eligible. Grandfather
// any returning player as already-welcomed so they're never handed a retroactive crate.
const freshVisitor = !identity;
if (identity) markWelcome();
// Hand a first-time rider a free Wooden crate — fired one tick after the gate closes so the reveal
// isn't drawn behind the closing modal. Guarded once-ever (welcome flag) + fresh-visitor-only.
function maybeWelcomeGift() {
  if (!shouldGrantWelcome(freshVisitor, welcomeClaimed())) return;
  markWelcome();
  setTimeout(() => crateBox.openGift("wooden"), 0);
}
// Show the how-to walkthrough once to a new player, THEN run the follow-up (the welcome gift).
// A returning player (flag already set) skips straight to `after`.
function maybeShowHowTo(after: () => void, namespace?: string) {
  if (howToSeen(browserStore, namespace)) { after(); return; }
  howto.open(() => { markHowToSeen(browserStore, namespace); after(); });
}
// The access wall's grant seams — HOISTED so both identity paths (and the reconnect block) can wire
// their own redeem into the same wall. "magic" grants all cars + 1,000 coins through the exact seams
// a crate pull uses; "perpz" unlocks entry and nothing else. Already-owned cars are skipped (no dup
// copies); coins go through the earned-coins seam so they persist, refresh the HUD, and sync to the
// server ledger when signed in.
const accessPorts: RedeemPorts = {
  rosterIds: CAR_DEFS.map((c) => c.name),                       // all roster cars — what "magic" unlocks
  owns: (id) => inventory.owns(id),
  grantCar: (id) => { inventory.grant(id); garage.grant(id); }, // bank it (+ server sync) AND flip its garage card
  credit: (n) => upgrades.addCoins(n),
};

// The first-run access wall remains mandatory. This menu entry is intentionally dismissible so a
// returning rider can redeem a second code, including the reward code, without clearing app data.
function openAccessCodeDialog() {
  if (hudRoot.querySelector('[data-access-wall="1"]')) return;
  const accountId = identity?.mode === "privy" ? session.address() : null;
  createAccessWall(hudRoot, {
    onRedeem: accountId
      ? (code) => redeemForAccount(code, {
          api, accountId, rosterIds: accessPorts.rosterIds, owns: accessPorts.owns,
          grantCar: accessPorts.grantCar, credit: accessPorts.credit, flush: () => accountSync.flush(),
        })
      : (code) => redeem(code, accessPorts),
    onUnlocked: () => lobbyHud.toast("Access code redeemed."),
    onDismiss: () => {},
  });
}
// The access wall is a HARD gate that now sits AFTER the identity choice, one per CONTEXT:
//  • GUEST — redeem is LOCAL (a durable per-browser flag). A browser that already redeemed skips it.
//  • ACCOUNT — redeem is pinned SERVER-SIDE (follows the player across devices). A hydrated account
//    that already redeemed skips it; a fresh one is walled until it enters a code.
// Each helper mounts the same wall with its own redeem, then runs `onDone` (welcome gift, etc.) once
// the wall clears — so the crate reveal is never drawn behind the wall.
function guestAccessThenEnter(onDone: () => void) {
  if (DEV_UNLOCK) { onDone(); return; }     // dev localhost: never wall the game
  if (anyRedeemed()) { onDone(); return; } // this browser already redeemed → straight through
  createAccessWall(hudRoot, {
    onRedeem: (code) => redeem(code, accessPorts), // guest-local, synchronous
    onUnlocked: onDone,
  });
}
function accountAccessThenEnter(onDone: () => void) {
  // Server state follows the account across devices. The scoped browser flag only covers an offline
  // redemption by this same wallet and can never leak guest or another account's access.
  const accountId = session.address();
  if (DEV_UNLOCK) { onDone(); return; }     // dev localhost: never wall the game
  if (accountSync.accessCodes().length > 0 || anyAccountRedeemed(accountId)) { onDone(); return; }
  createAccessWall(hudRoot, {
    onRedeem: (code) => redeemForAccount(code, {
      api, accountId, rosterIds: accessPorts.rosterIds, owns: accessPorts.owns,
      grantCar: accessPorts.grantCar, credit: accessPorts.credit, flush: () => accountSync.flush(),
    }),
    // Account switches leave a scene that was initialized around the previous identity. Redemption
    // is durable before this callback fires, so reboot into the new account instead of resuming it.
    onUnlocked: () => location.reload(),
  });
}
// Check the signed-in welcome without consuming it. The atomic claim runs only after VRF returns,
// immediately before the crate reward is applied.
async function offerWelcomeAccount() {
  try {
    await offerPendingAccountWelcome(
      () => api.welcomeStatus(),
      () => setTimeout(() => crateBox.openGift("wooden"), 0),
    );
  }
  catch { /* Railway is account truth. Never fall back to a local signed-in gift. */ }
}
let gateUp = false;
function showIdentityGate() {
  if (gateUp) return;
  gateUp = true;
  createIdentityGate(hudRoot, {
    prefill: identity?.name,
    // an existing rider peeking at the gate (chip tap / menu) can back out; a fresh
    // boot or a post-logout gate has no ✕ — you need to be SOMEBODY to ride
    onDismiss: identity ? () => { gateUp = false; } : undefined,
    onGuest(name) {
      identity = { name, mode: "guest" as const };
      saveIdentity(identity);
      reconnectPresenceForIdentity();
      syncOnchainBalance(); // renders the "practice" chip
      gateUp = false;
      // GUEST: the access wall (LOCAL) stands between the gate and the world; the welcome gift stays
      // local and fires only once the wall clears.
      guestAccessThenEnter(() => { maybeShowHowTo(() => maybeWelcomeGift()); });
    },
    async onSignIn(name) {
      // fresh = the account picker ALWAYS opens (a lingering Privy session is signed out
      // first). Resuming belongs to boot reconnect; the gate is where accounts switch.
      const transition = accountSignInTransition(identity);
      // Account hydration writes server truth into the live save. Preserve the guest save first
      // so logout can restore the exact coins, scrap, cars, upgrades, and cosmetic selections.
      if (transition.reloadForSaveSwap) stashSave(GUEST_SAVE_NAMESPACE);
      zeroLocalSnapshotForSignIn = transition.zeroLocalSnapshot;
      let ok: boolean;
      try { ok = await ensureSignedIn(true); }
      finally { zeroLocalSnapshotForSignIn = false; }
      // Surface the REAL failure on the gate instead of the generic "didn't finish" line —
      // ensureSignedIn already folded the error into `false`, so rethrow its saved message.
      if (!ok && lastSignInError) throw new Error(lastSignInError);
      if (ok) {
        if (name && !accountDriverName) {
          try {
            const saved = await api.setDriverName(name);
            accountDriverName = saved.driverName;
          } catch { /* Highway will require a confirmed Railway save before entry. */ }
        }
        identity = {
          name: accountDriverName ?? name ?? "rider_" + session.address().slice(-4).toLowerCase(),
          mode: "privy" as const,
        };
        saveIdentity(identity);
        reconnectPresenceForIdentity();
        if (transition.reloadForSaveSwap) {
          // Identity-scoped saves (guest to account only, never on a boot reconnect, which
          // would wipe the account's own live state every boot): wipe the hydrated live cache,
          // restore this account's stash from its last logout, then reload.
          // The reload IS the rehydration: nothing may run in between, or an in-memory
          // persist() would clobber the restored keys. After the boot, the reconnect path
          // re-applies server-wins hydrate + the access wall + how-to + the welcome claim.
          wipeSave();
          restoreSave(session.address() || "account");
          location.reload();
          return true;
        }
        syncOnchainBalance();
        gateUp = false;
        // ACCOUNT: ensureSignedIn already ran syncAccount → bindAndHydrate → accountSync.hydrate, so
        // accountSync.accessCodes() is populated — the wall shows only if THIS account hasn't redeemed.
        // The welcome crate (ONCE PER ACCOUNT, server-side) fires AFTER the wall clears so its reveal
        // isn't drawn behind the wall.
        accountAccessThenEnter(() => {
          maybeShowHowTo(() => { void offerWelcomeAccount(); }, session.address());
        });
      }
      return ok;
    },
  });
}
// The normal front door: the identity gate on a fresh boot (no rider), or a returning rider resuming.
// The access wall now lives INSIDE the identity paths (guest/accountAccessThenEnter), so it appears
// AFTER the player picks Guest or Sign in — never before the identity choice.
function bootIdentity() {
  if (!identity) { showIdentityGate(); return; } // fresh boot → the gate is the front door
  if (identity.mode === "guest") {
    syncOnchainBalance(); // returning guest → "practice" chip, NO wallet
    // returning guests already hold the local flag → the wall is skipped (onDone is a no-op: they're
    // already in-world). Kept for the odd guest who somehow lacks the flag — they get walled.
    guestAccessThenEnter(() => {});
  }
  // returning PRIVY users: their account access set only arrives with hydrate → walled in the
  // reconnect block below (NOT here — accountSync.accessCodes() is empty until hydrate lands).
}
// Boot ALWAYS resumes the identity flow now; the wall is deferred into whichever path the player picks.
bootIdentity();
(window as Window & { setSplashProgress?: (pct: number) => void }).setSplashProgress?.(90); // boot milestone: identity resolved
// Boot-order invariant: the enterHome()/enterLobby() in the boot tail above MUST run before this kick —
// the first frame() dispatches on `mode`, and only home mode renders nothing (the 3D branches deref the
// deferred world). rAF is async so it can't beat the synchronous boot tail; the "home" default backstops a re-order.
requestAnimationFrame(frame);
// Returning SIGNED-IN players see their money at the top immediately: silently restore the persisted
// wallet session, hydrate the account, THEN wall on the account's access set — a returning account
// that never redeemed still gets the wall; one that already redeemed skips it. Guests and fresh
// visitors get NO wallet — that's the point.
if (identity?.mode === "privy") {
  void session.reconnect().then(async (ok) => {
    if (!ok) return;
    signedIn = true;
    syncOnchainBalance();
    void syncTableCap();
    await syncAccount();                 // hydrate coins/scrap/cars + the account's redeemed-code set
    restoreHighwayPosition();
    reconnectPresenceForIdentity();
    // A guest-to-account save swap reloads before its post-wall flow can run, so the boot
    // reconnect completes it. Fresh account sign-ins continue in place on the warmed scene.
    accountAccessThenEnter(() => {
      maybeShowHowTo(() => { void offerWelcomeAccount(); }, session.address());
    });
  }).catch(() => {});
}
console.log("Perps Rider render up");

// DEV-only hooks so browser verification can jump between modes without driving
// across the lobby at Preview's throttled frame rate. Stripped from prod builds.
if (import.meta.env.DEV) {
  (window as any).__hw = {
    enterHighway, exitHighwayToLobby, enterLobby, exitLobby, triggerBuilding,
    enterGrandprix, exitGrandprixToHome,
    // sets the persistent override the frame loop reads (a direct setRemoteCars call
    // would be wiped by the very next frame)
    ghosts: (states: import("./render/oval").OvalRemoteCar[] | undefined) => { (window as any).__hwGhostStates = states; },
    gfx: { renderer: ctx.renderer, scene: ctx.scene, camera: ctx.camera }, // 7F draw-call/mesh-count probe (DEV-only)
    state: () => ({ mode, lev: highwayConfirmedLev, x: drive.x, z: drive.z, speed: drive.speed, roll: body.roll, pitch: body.pitch, rot: { x: car.group.rotation.x, y: car.group.rotation.y, z: car.group.rotation.z } }),
  };
  // on-chain probe (GO-path fault injection for browser verification) — e.g. wrap
  // session.open with a one-shot 6005 throw to prove the same-press table rebuild
  (window as any).__chain = { session };
  // racer lane-drive telemetry (7H browser verification) — reads the live physics state;
  // setTarget writes the same INPUT variable the pointer drag does (nothing below it)
  (window as any).__race = {
    state: () => ({
      mode, target: carXTarget, x: lane.x, vx: lane.vx, yaw: lane.yaw, steer: lane.steer,
      roll: body.roll, pitch: body.pitch,
      rot: { x: car.group.rotation.x, y: car.group.rotation.y, z: car.group.rotation.z, order: car.group.rotation.order },
    }),
    setTarget: (x: number) => { carXTarget = Math.max(-10, Math.min(10, x)); },
    flipWorld: () => worldFlip.trigger(), // preview the Helmet upside-down ride (needs a live round)
  };
}
