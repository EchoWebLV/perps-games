import { Buffer } from "buffer";
// @ts-ignore assign the browser global some Solana deps read at runtime
globalThis.Buffer = globalThis.Buffer || Buffer;
import * as THREE from "three";
import { createScene } from "./render/scene";
import { createWorld } from "./render/world";
import { createCar } from "./render/car";
import { createChaseCam, roadSpeed } from "./render/camera";
import { detectQuality } from "./platform/perf";
import { createPost } from "./render/post";
import { createHud } from "./ui/hud";
import { createTach } from "./ui/tach";
import { createControls } from "./ui/controls";
import { connectFeed } from "./core/feed";
import { createPriceSource } from "./core/price-source";
import { RoundEngine } from "./core/round";
import { createApi, type MarkResult } from "./core/api";
import { createDevAuth } from "./core/auth-dev";
import { createPrivyAuth } from "./core/auth-privy";
import type { AuthProvider } from "./core/auth";
import { usd } from "./core/money";
import { createRoundSync, clampInt } from "./core/round-sync";
import { niceLev, tToLev } from "./core/leverage";
import { liqPriceOf } from "./core/economics";
import { createUpgrades } from "./ui/upgrades";
import { CONFIG } from "./core/config";
import { createMinimap } from "./ui/minimap";
import { createPickups } from "./render/pickups";
import { createCarPicker, type CarAbility } from "./ui/carpicker";
import { createFx } from "./ui/fx";
import { createJoystick } from "./ui/joystick";
import { createAudio } from "./core/audio";
import { createRadio } from "./ui/radio";
import { createCoinCounter } from "./ui/coins";
import { createNitro } from "./ui/nitro";
import { createWallet } from "./ui/wallet";
import type { Snapshot } from "./core/types";
import { createLobby } from "./render/lobby";
import { createLobbyCam } from "./render/lobbycam";
import { createMapButton } from "./ui/mapbutton";
import { createLobbyHud } from "./ui/lobbyhud";
import { step as driveStep, DRIVE, type DriveState } from "./core/freedrive";
import { entranceHit, LOT_BOUNDS, type Asset } from "./core/lobby-layout";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;

const ctx = createScene(canvas);

// quality / post-processing (perf-gated)
const quality = detectQuality();
ctx.renderer.setPixelRatio(Math.min(quality.pixelRatioCap, window.devicePixelRatio || 1));
const post = quality.bloom ? createPost(ctx.renderer, ctx.scene, ctx.camera, quality.bloomScale) : null;
addEventListener("resize", () => {
  ctx.resize(window.innerWidth, window.innerHeight);
  post?.setSize(window.innerWidth, window.innerHeight);
});

// world + car
const world = createWorld();
ctx.scene.add(world.group);
// dismiss the loading splash (index.html) once the real car model is in
const car = createCar(() => (window as any).hideSplash?.());
car.group.position.set(0, 0, -12);
ctx.scene.add(car.group);
const chase = createChaseCam();
const pickups = createPickups();
ctx.scene.add(pickups.group);

// core
const engine = new RoundEngine();
// auth backend — default (dev) plays immediately as a guest; VITE_AUTH=privy gates login at boot.
const usePrivy = (import.meta.env?.VITE_AUTH as string) === "privy";
const auth: AuthProvider = usePrivy
  ? createPrivyAuth(import.meta.env.VITE_PRIVY_APP_ID as string)
  : createDevAuth();
const api = createApi({ auth });
// Sign-in is gated on INTENT, not at boot. Logged-out visitors see the 3D preview and can toggle
// music/menu freely; pressing GO or the lobby button opens the sign-in. `signedIn` flips true once
// the session loads (privy: after login · dev: immediately).
let signedIn = false;
function triggerSignIn() { if (auth.login) auth.login(); } // privy: open the login modal · dev: no-op
const roundSync = createRoundSync({ api, clock: { now: () => performance.now() }, store: { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } } });
let balance = 0;                   // server-owned; seeded by api.me()
let connected = false;

// Live "mark": the SERVER's current equity for the open round. The displayed × / buffer / payout
// and the terminal (liq/cap/time) are driven by this so what you see == what you settle for.
// SAMPLE-AND-HOLD: the mark refreshes ~once a second and the display holds it rock-steady between
// reveals, so the × is a readable number you can tap — not a 5Hz flicker that's unreadable at high
// leverage. You settle at the held value; you can only be liquidated AT a reveal, never mid-hold.
// The local engine stays only for the smooth car visual + the ~RTT pre-first-mark gap.
const MARK_HOLD_MS = 1000; // sample-and-hold reveal interval
let serverMark: MarkResult | null = null;
let marking = false;
let lastMarkMs = 0;
async function pollMark() {
  const id = roundSync.roundId();
  if (!id || marking) return;
  marking = true;
  try {
    const m = await api.markRound(id);
    if (m.status === "open" && !m.stale) serverMark = m; // ignore stale → hold the last mark
  } catch { /* transient: hold the last mark */ }
  finally { marking = false; }
}

// price feeds — BTC / ETH / SOL (subscribe to all; the active one drives the game)
const ASSETS = [
  { key: "BTC", lz: 1, hx: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8 },
  { key: "ETH", lz: 2, hx: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", expo: -8 },
  { key: "SOL", lz: 6, hx: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8 },
];
let asset: "BTC" | "ETH" | "SOL" = "SOL";
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: ASSETS, onPrice: (k, v) => { if (k === asset) onPrice(v); } });
    return () => h.stop();
  },
});
addEventListener("pagehide", () => priceSource.stop());

// ui
const hud = createHud(hudRoot);
const tach = createTach(hud.tachMount);
const controls = createControls(hud.ctrlMount, hud.goMount, hud.pedalMount);
const minimap = createMinimap(hud.miniCanvas);
const fx = createFx();
const joystick = createJoystick();
const audio = createAudio();
const coins = createCoinCounter(hudRoot);
// Orion's Nitro Overdrive — 2× leverage burst; the button fires it, main applies the boost
const nitro = createNitro(hudRoot, () => { fx.nitro(); chase.shake(0.7); navigator.vibrate?.([0, 30, 20, 40]); });
hud.setBalance(balance);
// persistent coin balance + the upgrade tree (Turbo / Tank / Suspension); buying spends coins
const upgrades = createUpgrades(hudRoot, { onCoins: (n) => coins.set(n), onApply: () => tach.rebuild(), economicEffects: false });
coins.set(upgrades.coins(), false); // no pulse on the persisted balance at load

// wallet page (opened by tapping the balance chip) — buy USDC + show the deposit QR.
// Placeholder deposit address; the real one comes from the backend wallet later.
const USDC_ADDRESS = "4Nd1mYpVxKfBnW9sRtQ2zJhG7cUaEo3LpXyZ6vTbKmHd";
const walletUI = createWallet(hudRoot, {
  // privy: the captured embedded Solana wallet (also the deposit target + drives the account row);
  // dev/guest: walletPublicKey() is null → fall back to the placeholder so the deposit QR is unchanged.
  address: auth.walletPublicKey?.() || USDC_ADDRESS,
  balance: () => balance,
  onBuy: () => { hud.setStatus("Deposits open when real money goes live."); },
  // logout shows only for a real signed-in account (dev → undefined → account row stays hidden)
  onLogout: auth.logout ? () => { void auth.logout!(); location.reload(); } : undefined,
});
hud.onWallet(() => { if (engine.getPhase() !== "live") walletUI.open(); });

// Session init: seed the server-owned balance + settle any dangling round. Runs once the user is
// authenticated — privy: after the login modal completes; dev: immediately (dev ready() resolves at
// once, so guests still auto-load). Logged-out visitors never hit the server until they sign in.
async function initSession() {
  if (signedIn) return;
  try {
    const me = await api.me();
    balance = me.balance;
    connected = true;
    signedIn = true;
    hud.setBalance(balance);
    if (me.openRoundId) await roundSync.recover(me.openRoundId);
    const refreshed = await api.me();
    balance = refreshed.balance; hud.setBalance(balance);
  } catch {
    connected = false;
    hud.setStatus("Can't reach the server — reconnecting…");
  }
}
void auth.ready().then(initSession);

// car picker — swap the GLB model live + apply the card's special ability
let ability: CarAbility | undefined;
const setAbility = (a?: CarAbility) => {
  ability = a;
  world.setLaneBet(a === "laneBet");      // Clown Car colors the road green/red
  controls.setLaneMode(a === "laneBet");  // keep LONG/SHORT visible as a live readout
  nitro.setEnabled(a === "nitro");        // Orion shows the Nitro Overdrive button
  pickups.setRainbow(a === "rainbow");    // Vaporwave: rainbow coins + value multipliers
};
// synthwave radio — streams on the first gesture; its on/off toggle lives in the menu (below)
const radio = createRadio(hudRoot);
const garage = createCarPicker(hudRoot, [
  { name: "DeLorean", url: "/models/car.glb?v=2", power: { name: "Flux Brake", desc: "freeze your P&L ~4s", icon: "clock" } },
  { name: "Cybertruck", url: "/models/cybertruck.glb", scale: 1.3, power: { name: "Exoskeleton", desc: "survive deeper drops", icon: "shield" } },
  { name: "Orion", url: "/models/orion.glb", yaw: -Math.PI / 2, ability: "nitro", power: { name: "Nitro Overdrive", desc: "2× leverage · 3s", icon: "flame" } },
  { name: "Vaporwave", url: "/models/vaporwave.glb", ability: "rainbow", power: { name: "Rainbow Coins", desc: "×2 ×3 ×5 coin drops", icon: "magnet" } },
  { name: "Flintstone", url: "/models/flinstone.glb", scale: 0.7, power: { name: "Stone-Age Airbag", desc: "keep stake on liq", icon: "chute" } },
  { name: "Clown Car", url: "/models/clowncar.glb", yaw: Math.PI / 2, ability: "laneBet", power: { name: "Lane Bet", desc: "steer = LONG / SHORT", icon: "swap" } },
  // newly-added models — same pack as the Clown Car (length-on-X, no wheel nodes) → yaw +π/2.
  // placeholder names, no ability yet. If any one model faces backwards, it needs +π instead.
  { name: "Car 5", url: "/models/5.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Car 6", url: "/models/6.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Car 7", url: "/models/7.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Car 8", url: "/models/8.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Default", url: "/models/default.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
], (c) => { car.setModel(c.url, c.scale, c.yaw); setAbility(c.ability); }, () => upgrades.open(), [
  { label: "Music", sub: "synthwave radio", glyph: "♫", get: () => radio.isOn(), set: (on) => radio.setOn(on) },
  { label: "SFX", sub: "engine & coins", glyph: "🔊", get: () => audio.isEnabled(), set: (on) => audio.setEnabled(on) },
]);

// ── parking-lot lobby ──────────────────────────────────────────────────────
// the map button drops you into a giant drivable neon lot with 3 market buildings;
// driving into a building selects that market and returns you to the race
const lobby = createLobby();
ctx.scene.add(lobby.group);
const lobbyCam = createLobbyCam();
let mode: "race" | "lobby" = "race";
let drive: DriveState = { x: 0, z: LOT_BOUNDS.z - 8, heading: 0, speed: 0, steer: 0 };
let doorDwell = 0;
let steerNorm = 0; // steering from the pointer drag (-1..1), shared with the lobby

const hudPrev = new Map<HTMLElement, string>();
function setRaceHudVisible(visible: boolean) {
  for (const child of Array.from(hudRoot.children) as HTMLElement[]) {
    if (child === mapBtn.el || child === lobbyHud.el) continue;
    if (!visible) { hudPrev.set(child, child.style.display); child.style.display = "none"; }
    else { const d = hudPrev.get(child); if (d !== undefined) child.style.display = d; }
  }
  if (visible) hudPrev.clear();
}

function enterLobby() {
  if (engine.getPhase() === "live") return;
  mode = "lobby";
  drive = { x: 0, z: LOT_BOUNDS.z - 8, heading: 0, speed: 0, steer: 0 };
  doorDwell = 0;
  lobbyCam.reset();
  world.group.visible = false;
  pickups.group.visible = false;
  lobby.show();
  setRaceHudVisible(false);
  mapBtn.setVisible(false);
  lobbyHud.show();
  audio.resume(); radio.resume();
}

function exitLobby(selected?: Asset) {
  mode = "race";
  lobby.hide();
  lobbyHud.hide();
  lobbyHud.setPrompt(null);
  world.group.visible = true;
  pickups.group.visible = true;
  setRaceHudVisible(true);
  mapBtn.setVisible(true);
  // restore the road car pose; the chase cam takes back over next frame
  car.group.position.set(0, 0, -12);
  car.group.rotation.set(0, 0, 0);
  if (selected) {
    asset = selected;
    solSmooth = 0; solEMA = 0; priceHist.length = 0;
    hud.setActiveAsset(selected);
  }
}

const mapBtn = createMapButton(hudRoot, () => {
  if (mode !== "race") return;
  if (!signedIn) { triggerSignIn(); return; } // the lobby requires sign-in
  enterLobby();
});
const lobbyHud = createLobbyHud(hudRoot, () => exitLobby());

// throttle = the accelerator: gas revs it up, brake slows it, release coasts down SLOWLY
let throttle = 34; // 0..100 (starts ~50x)
const GAS = 52, BRAKE = 78, COAST = 6;
const game = { lev: niceLev(tToLev(throttle)), equity: 1 };
let lastLivePrice = 0;
let solSmooth = 0; // eased display price → a flowing minimap curve (raw price drives economics)
let solEMA = 0;    // slow average; price vs this drives the terrain elevation

// price history (minimap), lateral steering, and the active round's entry
const priceHist: number[] = [];
let carX = 0, carXTarget = 0;
let roundStartMs = 0;
const round = { entryPx: 0, dir: 1 as 1 | -1 };

// asset switching (BTC/ETH/SOL) — blocked mid-bet; resets the chart for the new asset
hud.onAsset((a) => {
  if (engine.getPhase() === "live") return;
  asset = a as "BTC" | "ETH" | "SOL";
  solSmooth = 0;
  solEMA = 0;
  priceHist.length = 0;
  hud.setActiveAsset(a);
});
hud.setActiveAsset(asset);

// hold anywhere on the open scene to DRIVE: press & hold = gas, drag left/right =
// steer, pull back (drag down) = brake, release = coast. HUD buttons capture their
// own taps, so this only fires on the road/scene behind the dock.
let holding = false, touchGas = false, touchBrake = false;
let anchorX = 0, anchorY = 0, anchorCarX = 0;
canvas.addEventListener("pointerdown", (e) => {
  audio.resume(); radio.resume(); // unlock audio + start the radio on the first touch
  if (mode !== "lobby" && engine.getPhase() !== "live") return; // showroom: no driving until live (lobby is always drivable)
  holding = true; touchGas = true; touchBrake = false;
  anchorX = e.clientX; anchorY = e.clientY; anchorCarX = carXTarget;
  joystick.show(e.clientX, e.clientY); // white ring at the thumb
});
const releaseHold = () => { holding = false; touchGas = false; touchBrake = false; steerNorm = 0; joystick.hide(); };
addEventListener("pointerup", releaseHold);
addEventListener("pointercancel", releaseHold);
addEventListener("pointermove", (e) => {
  if (!holding) return;
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

// single settle path — local prediction already animated the ride; the server's
// close result is authoritative for balance + outcome, and FX waits for it.
let settling = false;
async function settleVia(reason: "cashout" | "expire", localSnap: Snapshot) {
  if (settling) return;
  settling = true;
  releaseHold();   // drop any active hold so the now-parked car can't be steered
  controls.setLive(true, "Settling…");
  const res = await roundSync.close(reason);
  settling = false;
  // reset UI regardless of outcome
  throttle = 34; game.equity = 1; serverMark = null; chase.setDriving(false);
  garage.setBusy(false); mapBtn.setVisible(true); upgrades.setBusy(false);
  walletUI.setBusy(false);
  hud.setTimer(CONFIG.MAXSEC, false);
  if (!res) { // feed-halt / gave up -> the round will settle via 1.4
    controls.setLive(false, "GO!");
    hud.setStatus("Round will settle shortly — feed interruption.");
    return;
  }
  balance = res.balance; hud.setBalance(balance); walletUI.setBalance(balance);
  controls.setLive(false, "GO!");
  hud.setMultiplier(res.equity, res.outcome === "liq" ? "liquidated" : "settled");
  if (res.outcome === "liq") {
    hud.setStatus(`💥 Liquidated. Lost your stake.`);
    fx.liquidate(); audio.liquidate(); navigator.vibrate?.([30, 40, 30, 40, 90]);
  } else {
    hud.setStatus(`Settled at ×${res.equity.toFixed(2)} — banked ${usd(res.payoutCoins)}.`);
    fx.confetti(); audio.cashout(); navigator.vibrate?.(35);
  }
  void localSnap; // local prediction already animated the ride; server result is authoritative
}

controls.onLaunch(async () => {
  if (mode === "lobby") return; // Space/Enter in the lot must not launch a round behind the scene
  audio.resume(); radio.resume(); // unlock audio + radio if GO! is the first interaction
  if (!signedIn) { triggerSignIn(); return; } // GO requires sign-in — opens the login; race on the next press
  if (!connected) { hud.setStatus("Can't reach the server — reconnecting…"); return; }
  if (roundSync.isOpening() || engine.getPhase() === "live") return;  // re-entrancy guard
  const stake = controls.stake();
  if (balance < stake) { hud.setStatus("Not enough balance — lower your stake."); return; }
  const lev = clampInt(game.lev, 10, 1000);                          // parity: send the clamped value
  hud.setStatus("Launching…");
  let out;
  try { out = await roundSync.open({ asset: asset as "BTC"|"ETH"|"SOL", dir: controls.dir(), lev, stake }); }
  catch (e: any) {
    const code = e?.code;
    hud.setStatus(code === "insufficient_balance" ? "Not enough balance — lower your stake."
      : code === "feed_halt" ? "Feed is down — try again in a moment."
      : code === "round_already_open" ? "You have a round in progress — it'll settle shortly."
      : "Can't reach the server — try again.");
    return;
  }
  if (!out) return;
  round.entryPx = out.entryRaw;
  round.dir = controls.dir();
  roundStartMs = out.entryTsUs / 1000;                               // parity: server clock
  engine.launch({ dir: controls.dir(), lev, stake, entryRaw: out.entryRaw, startMs: roundStartMs });
  serverMark = null; lastMarkMs = 0; // fresh mark for the new round
  chase.setDriving(true); // smooth transition from the idle orbit into the chase cam
  controls.setLive(true, "CASH OUT");
  garage.setBusy(true); mapBtn.setVisible(false); upgrades.setBusy(true); walletUI.setBusy(true);
  hud.setStatus("");
});

controls.onCashout(() => {
  if (engine.getPhase() !== "live") return;
  const snap = engine.cashout(priceSource.price(), Date.now());
  void settleVia("cashout", snap);
});

function frame() {
  const dt = Math.min(0.05, ctx.clock.getDelta()); // clamp so a frame hitch can't teleport the world

  if (mode === "lobby") {
    // touch (hold + drag) OR keyboard (W/↑ gas, S/↓ brake, A/D ←→ steer) — shared with the road
    const kSteer = controls.steer();
    const gas = holding || controls.gas();
    const brake = touchBrake || controls.brake();
    const throttle = brake ? -1 : gas ? 1 : 0;
    const steer = Math.max(-1, Math.min(1, (holding ? steerNorm : 0) + kSteer));
    drive = driveStep(drive, { throttle, steer }, dt, LOT_BOUNDS);

    car.update(dt);
    car.setEquity("idle", 1);
    car.group.position.set(drive.x, 0, drive.z);
    // -heading: Three's +Y rotation mirrors X vs the physics/camera (sin,-cos) convention,
    // so the body must use -heading to actually face the way it drives (camera stays behind it)
    car.group.rotation.set(0, -drive.heading, 0);
    car.setSteer(drive.steer / DRIVE.MAX_STEER_LOW); // front wheels point to the real steer angle

    const hit = entranceHit(drive.x, drive.z);
    lobbyHud.setPrompt(hit);
    if (hit) { doorDwell += dt; if (doorDwell > 0.45) exitLobby(hit); }
    else doorDwell = 0;

    lobby.update(dt);
    lobby.setRemoteCars([]); // multiplayer seam — empty today
    lobbyCam.update(ctx.camera, dt, drive.x, drive.z, drive.heading);

    if (post) post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(frame);
    return;
  }

  const price = priceSource.price();
  const live = priceSource.live();
  if (live && price > 0) lastLivePrice = price;
  // ease the display price toward the latest tick → smooth, wave-like minimap line
  if (price > 0) solSmooth = solSmooth ? solSmooth + (price - solSmooth) * 0.1 : price;
  if (solSmooth > 0) solEMA = solEMA ? solEMA + (solSmooth - solEMA) * 0.012 : solSmooth;
  hud.setPrice(solSmooth || price, live);
  if (solSmooth > 0) { priceHist.push(solSmooth); if (priceHist.length > 300) priceHist.shift(); }

  // spec §9: never settle P&L on a stale feed. Freeze equity at the last real
  // price when the feed is down so sim drift can't liquidate a live round.
  const roundPrice = live ? price : lastLivePrice || price;
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
  game.lev = clampInt(niceLev(tToLev(throttle)) * boost, 10, 1000); // parity: never exceed server RMAX
  tach.setThrottle(Math.min(1, (throttle / 100) * boost), game.lev); // needle pegs during nitro
  audio.engine(throttle / 100, gasOn || drivable); // rev drone tracks leverage (live only)
  if (drivable) { engine.setLeverage(game.lev, roundPrice); roundSync.noteLeverage(game.lev); }
  roundSync.pump();

  if (engine.getPhase() === "live") {
    const nowMs = Date.now();
    if (nowMs - lastMarkMs > MARK_HOLD_MS) { lastMarkMs = nowMs; void pollMark(); } // sample-and-hold: reveal the mark ~1×/s
    // read-only snapshot (never auto-settles) = the pre-mark fallback; the SERVER mark is authoritative
    const snap = engine.snapshot(roundPrice, nowMs);
    const m = serverMark;
    const serverTerminal = m ? (m.outcome === "liq" || m.outcome === "cap" || m.outcome === "time") : false;
    const timeUp = (nowMs - roundStartMs) / 1000 >= CONFIG.MAXSEC; // backstop if marks lag at the cap
    if (serverTerminal || timeUp) {
      void settleVia("expire", engine.cashout(roundPrice, nowMs)); // server settles authoritatively
    } else {
      const eq = m ? m.equity : snap.equity;
      const buf = m ? m.buffer : snap.buffer;
      const payC = m ? m.payoutCoins : Math.floor(snap.payout);
      game.equity = eq;
      hud.setMultiplier(eq, "live");
      controls.setBuffer(buf);              // the bail button IS the liquidation bar
      hud.setTimer(CONFIG.MAXSEC - (nowMs - roundStartMs) / 1000, true);
      car.setEquity("live", eq);
      const win = eq >= 1;
      controls.setLive(true, `${win ? "CASH OUT" : "BAIL"} ${usd(payC)}`, !win);
    }
  } else {
    car.setEquity("idle", 1);
    hud.setTimer(CONFIG.MAXSEC, false);
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
        if (laneDir !== round.dir) {
          engine.setDir(laneDir, roundPrice);
          round.dir = laneDir;
          round.entryPx = roundPrice;          // re-anchored on the flip (drives the liq line)
          roundSync.noteFlip(laneDir);         // mirror the flip to the server segment stream
        }
        controls.setDir(laneDir);              // reflect on the LONG/SHORT readout
      }
    }
  } else {
    carXTarget += (0 - carXTarget) * 0.12;     // ease back to centre while parked
  }
  carX += (carXTarget - carX) * 0.18;

  const live2 = drivable;
  // price-driven terrain bias: road climbs when SOL is above its average, dips when below
  const hill = Math.max(-7, Math.min(7, (solEMA ? solSmooth / solEMA - 1 : 0) * 2600));
  const speed = roadSpeed(throttle / 100, game.equity, live2) * boost; // Nitro: road rips by 2× faster
  world.update(dt, speed, hill);

  // car hugs the road: ride the surface height + pitch to the local slope, lean into turns
  const carY = world.surfaceY(-12);
  const aheadY = world.surfaceY(-15.4), behindY = world.surfaceY(-8.6);
  car.update(dt);
  car.group.position.x = carX;
  car.group.position.y = carY;
  car.group.rotation.x = Math.max(-0.4, Math.min(0.4, Math.atan2(aheadY - behindY, 6.8)));
  // steer like a real car: point the nose INTO the lane change (not crab sideways),
  // turn the front wheels, and bank the body. Bigger yaw so it reads as steering;
  // it eases back to straight as the car settles into the new lane.
  const turn = Math.max(-1, Math.min(1, (carXTarget - carX) / 2.4));
  car.setSteer(turn);
  car.group.rotation.y = turn * 0.36;
  car.group.rotation.z = Math.max(-0.18, Math.min(0.18, -turn * 0.14));

  // camera: idle showroom orbit when parked, smooth blend to the chase cam while driving
  chase.update(ctx.camera, dt, speed, carY, carX);

  // collectible coins: cosmetic only — they must NOT affect P&L, or every
  // round becomes a guaranteed win and the long/short bet stops mattering
  const hit = pickups.update(dt, speed, carX, world.surfaceY, drivable);
  if (hit.count > 0) {
    upgrades.addCoins(hit.value); // value carries Vaporwave's ×2/×3/×5; refreshes the counter
    audio.coin(hit.count);
    if (hit.pops.length) {
      // project a point just above the car to screen space so the ×N rises over IT
      const ndc = new THREE.Vector3(carX, carY + 3.5, -12).project(ctx.camera);
      const sx = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
      hit.pops.forEach((m, k) => fx.coinPop(m, sx + (k - (hit.pops.length - 1) / 2) * 34, sy)); // stagger multiples
    }
  }

  // minimap: live SOL price line with entry/liq overlays
  const liqPx = live2 ? liqPriceOf(round.entryPx, round.dir, game.lev, CONFIG.LIQ) : 0;
  minimap.draw({ hist: priceHist, inRun: live2, equity: game.equity, entryPx: round.entryPx, liqPx, dir: round.dir });

  if (post) post.render();
  else ctx.renderer.render(ctx.scene, ctx.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
console.log("redline3d render up");
