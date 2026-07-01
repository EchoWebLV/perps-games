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
import { sol3 } from "./core/money";
import { clampInt } from "./core/round-sync";
import { niceLev, tToLev } from "./core/leverage";
import { liqPriceOf } from "./core/economics";
import { createUpgrades } from "./ui/upgrades";
import { CONFIG } from "./core/config";
import { createMinimap } from "./ui/minimap";
import { createPickups } from "./render/pickups";
import { createCarPicker, type CarAbility } from "./ui/carpicker";
import { createAuthGate } from "./ui/auth-gate";
import { createFx } from "./ui/fx";
import { createDeathsDoor } from "./ui/deaths-door";
import { createAutoExit } from "./ui/pinkrod";
import { createJoystick } from "./ui/joystick";
import { createAudio } from "./core/audio";
import { createRadio } from "./ui/radio";
import { createCoinCounter } from "./ui/coins";
import { createNitro } from "./ui/nitro";
import { createWallet } from "./ui/wallet";
import { createLobby } from "./render/lobby";
import { createLobbyCam } from "./render/lobbycam";
import { createMapButton } from "./ui/mapbutton";
import { createLobbyHud } from "./ui/lobbyhud";
import { step as driveStep, DRIVE, type DriveState } from "./core/freedrive";
import { entranceHit, LOT_BOUNDS, LOBBY_SPAWN, type BuildingKind } from "./core/lobby-layout";
import { PublicKey } from "@solana/web3.js";
import { CHAIN } from "./chain/config";
import { createGameSession } from "./chain/game-session";
import { selectChainWalletPort } from "./chain/wallet-select";

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
// ── on-chain round (Slice 4) ────────────────────────────────────────────────
// The round loop + SOL play balance run on-chain via the dev-keypair port. The local engine
// still drives the smooth visual ×; the on-chain Round is the only money truth.
// The play ledger is denominated in CENTI-SOL units (1 unit = 0.01 SOL). With 9-decimal
// wSOL this maps a unit to 10^7 lamports — the same ×100 scale the old cents model used.
const BASE_PER_UNIT = 10 ** (CHAIN.STAKE_DECIMALS - 2); // 9-decimal SOL, 0.01-SOL units → 10_000_000 lamports
const unitsToBase = (units: number) => units * BASE_PER_UNIT;
const baseToUnits = (base: bigint) => Number(base / BigInt(BASE_PER_UNIT));
const BUY_IN_BASE = 100_000_000; // 0.1 SOL auto buy-in float on the first GO (covers one max-stake round)
let lastStakeUnits = 0;
void lastStakeUnits; // recorded at open for the upcoming wager-history slice; not read on the hot path yet
let roundActive = false; // a round is open locally (de-dupes finalizeSettled across crank/poll/close)
let settling = false;    // a close tx is in flight
let nearDeath = false;   // Skull "Death's Door" danger latch (hysteresis so it doesn't flicker)
let opening = false;     // the GO handler (ensureSession+open) is mid-flight
const session = createGameSession({
  mint: new PublicKey(CHAIN.STAKE_MINT),
  onSettled: (info) => finalizeSettled(info), // terminal-first background lever
  port: selectChainWalletPort(), // dev-keypair by default; Privy under VITE_WALLET=privy
});
// The cash chip + wallet hero read the on-chain play balance (centi-SOL units). Single writer.
function syncOnchainBalance() {
  // Un-floored centi-SOL (base lamports / BASE_PER_UNIT) so the balance shows true 3-decimal
  // SOL — the floored `baseToUnits` would drop sub-0.01 SOL that a cash-out leaves behind.
  // Display-only: money logic reads `session.balance()` (base units) directly.
  balance = Number(session.balance()) / BASE_PER_UNIT;
  hud.setBalance(balance);
  walletUI.setBalance(balance);
}
// NOTE: the login gate is created near the END of setup (createHud does
// `hudRoot.innerHTML = …`, which would wipe a gate added here). See `authGate` below.
// The game is fully on-chain: the SOL play balance + round loop live in `session` (the ER round).
// `balance` is the displayed cash chip, sourced only from the on-chain play balance (centi-SOL units).
let balance = 0;

// price feeds — BTC / ETH / SOL (subscribe to all; the active one drives the game)
const ASSETS = [
  { key: "BTC", lz: 1, hx: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8 },
  { key: "ETH", lz: 2, hx: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", expo: -8 },
  { key: "SOL", lz: 6, hx: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8 },
];
let asset: "BTC" | "ETH" | "SOL" = "BTC"; // the active tab; open() binds the round to this asset's registered Lazer feed
let solUsd = 0; // live SOL/USD (captured from the feed regardless of active asset) → balance ~$ hint
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: ASSETS, onPrice: (k, v) => { if (k === "SOL") solUsd = v; if (k === asset) onPrice(v); } });
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
const deathsDoor = createDeathsDoor(); // Skull car: near-death sequence at the liq floor
// Pink Rod's Auto-Exit (stop-loss / take-profit) panel — appended into the pre-round control
// stack AFTER createControls set its innerHTML; values are stamped on-chain at GO.
const autoExit = createAutoExit(hud.ctrlMount);
const joystick = createJoystick();
const audio = createAudio();
const coins = createCoinCounter(hudRoot);
// Orion's Nitro Overdrive — 2× leverage burst; the button fires it, main applies the boost
const nitro = createNitro(hudRoot, () => { fx.nitro(); chase.shake(0.7); navigator.vibrate?.([0, 30, 20, 40]); });
hud.setBalance(balance);
// Effective leverage ceiling = the upgrade-driven CONFIG.RMAX, raised to a car's base if higher
// (the Cybertruck starts at 1500). Nitro (Orion) then doubles the live leverage on top of this.
let carBaseLev = 0;
const effRmax = () => Math.max(CONFIG.RMAX, carBaseLev);
// persistent coin balance + the upgrade tree; buying spends coins. Turbo Kit (max leverage) and
// Long-Range Tank (round time) apply live now that the on-chain program honors both.
const upgrades = createUpgrades(hudRoot, {
  onCoins: (n) => coins.set(n),
  onApply: () => tach.rebuild(effRmax()),
  economicEffects: true,
  onClose: () => { if (mode === "lobby") lobbyHud.show(); }, // returning to the lobby town → restore the back button
});
coins.set(upgrades.coins(), false); // no pulse on the persisted balance at load

// wallet page (opened by tapping the balance chip) — shows the player's deposit QR.
const walletUI = createWallet(hudRoot, {
  // the wallet shown for funding is the on-chain session wallet (Privy embedded / dev keypair)
  address: () => session.address(),
  balance: () => balance,
  onchain: {
    status: () => ({ delegated: session.delegated(), playCents: baseToUnits(session.balance()) }),
    // One player action. "Cash out" quietly undelegates the ER session (if one is live) and THEN
    // withdraws to the wallet — the player never sees the delegate/undelegate lifecycle, they just
    // move their balance to their wallet in a single tap.
    cashOut: async () => {
      hud.setStatus("Cashing out…");
      if (session.delegated()) await session.endSession(); // undelegate under the hood
      await session.withdraw();
      syncOnchainBalance();
      hud.setStatus("Cashed out to your wallet.");
    },
  },
  // Log out moved to the menu (settings); the wallet page is deposit-only now.
});
hud.onWallet(() => { if (engine.getPhase() !== "live") walletUI.open(); });

// car picker — swap the GLB model live + apply the card's special ability
let ability: CarAbility | undefined;
const setAbility = (a?: CarAbility) => {
  ability = a;
  world.setLaneBet(a === "laneBet");      // Clown Car colors the road green/red
  controls.setLaneMode(a === "laneBet");  // keep LONG/SHORT visible as a live readout
  nitro.setEnabled(a === "nitro");        // Orion shows the Nitro Overdrive button
  pickups.setRainbow(a === "rainbow");    // Vaporwave: rainbow coins + value multipliers
  deathsDoor.setEnabled(a === "skull");   // Skull: near-death sequence when equity hits the floor
  autoExit.setEnabled(a === "pinkRod");   // Pink Rod: pre-round stop-loss / take-profit sliders
};
// synthwave radio — streams on the first gesture; its on/off toggle lives in the menu (below)
const radio = createRadio(hudRoot);
const garage = createCarPicker(hudRoot, [
  { name: "DeLorean", url: "/models/delorean.glb", power: { name: "Flux Brake", desc: "freeze your P&L ~4s", icon: "clock" } },
  { name: "Cybertruck", url: "/models/cybertruck.glb", scale: 1.3, baseLev: 1500, power: { name: "Overclocked", desc: "starts at 1500× leverage", icon: "gauge" } },
  { name: "Orion", url: "/models/orion.glb", yaw: -Math.PI / 2, ability: "nitro", power: { name: "Nitro Overdrive", desc: "2× leverage · 3s", icon: "flame" } },
  { name: "Vaporwave", url: "/models/vaporwave.glb", ability: "rainbow", power: { name: "Rainbow Coins", desc: "×2 ×3 ×5 coin drops", icon: "magnet" } },
  { name: "Flintstone", url: "/models/flintstone.glb", scale: 0.7, power: { name: "Stone-Age Airbag", desc: "keep play amount on liq", icon: "chute" } },
  { name: "Clown Car", url: "/models/clown-car.glb", yaw: Math.PI / 2, ability: "laneBet", power: { name: "Lane Bet", desc: "steer = LONG / SHORT", icon: "swap" } },
  // headline new cars — abilities still to be designed (brainstorming car-by-car).
  // skull/slot-machine are different model sources; yaw is a guess (+π/2) — fix if a card faces backwards.
  { name: "Skull", url: "/models/skull.glb", yaw: Math.PI / 2, ability: "skull", power: { name: "Death's Door", desc: "survive a liq for 2s", icon: "skull" } },
  { name: "Slot Machine", url: "/models/slot-machine.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  // descriptive-renamed placeholders (were Car 5–8 / Default) — same pack, length-on-X → yaw +π/2.
  { name: "Cart Rod", url: "/models/shopping-cart.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Helmet", url: "/models/helmet.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Pink Rod", url: "/models/pink-rod.glb", yaw: Math.PI / 2, ability: "pinkRod", power: { name: "Auto-Exit", desc: "set a stop-loss / take-profit", icon: "target" } },
  { name: "Six Wheeler", url: "/models/six-wheeler.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
  { name: "Starter", url: "/models/starter.glb", yaw: Math.PI / 2, power: { name: "New Ride", desc: "ability TBD", icon: "car" } },
], (c) => { car.setModel(c.url, c.scale, c.yaw); setAbility(c.ability); carBaseLev = c.baseLev ?? 0; tach.rebuild(effRmax()); }, () => upgrades.open(), [
  { label: "Music", sub: "synthwave radio", glyph: "♫", get: () => radio.isOn(), set: (on) => radio.setOn(on) },
  { label: "SFX", sub: "engine & coins", glyph: "🔊", get: () => audio.isEnabled(), set: (on) => audio.setEnabled(on) },
], () => {
  // Log out (garage menu → account): sign out the session and return to the sign-in gate.
  void session.logout().then(() => syncOnchainBalance());
  authGate.show();
}, () => {
  // closed from the lobby Garage building → re-hide the hamburger chrome and restore the lobby back button
  if (mode === "lobby") { garage.el.style.display = "none"; lobbyHud.show(); }
});

// ── lobby: the economy-hub town ─────────────────────────────────────────────
// the map button drops you into a giant drivable neon lot with 4 functional buildings —
// Garage (cars), Upgrades, Crates (coming soon), Track (back to the race). Solo / no netcode.
const lobby = createLobby();
ctx.scene.add(lobby.group);
const lobbyCam = createLobbyCam();
let mode: "race" | "lobby" = "race";
let drive: DriveState = { x: LOBBY_SPAWN.x, z: LOBBY_SPAWN.z, heading: 0, speed: 0, steer: 0 };
let doorDwell = 0;
let doorArmed = true; // disarmed after entering a building until the car leaves every doorway (no instant re-open)
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
  drive = { x: LOBBY_SPAWN.x, z: LOBBY_SPAWN.z, heading: 0, speed: 0, steer: 0 };
  doorDwell = 0;
  doorArmed = true;
  lobbyCam.reset();
  world.group.visible = false;
  pickups.group.visible = false;
  lobby.show();
  setRaceHudVisible(false);
  mapBtn.setVisible(false);
  lobbyHud.show();
  audio.resume(); radio.resume();
}

function exitLobby() {
  mode = "race";
  lobby.hide();
  lobbyHud.hide();
  lobbyHud.setPrompt(null);
  world.group.visible = true;
  pickups.group.visible = true;
  setRaceHudVisible(true);
  mapBtn.setVisible(true);
  // restore the road car pose; the chase cam takes back over next frame.
  // market (BTC/ETH/SOL) stays whatever it was — it's chosen from the in-race HUD tabs, not the lobby.
  car.group.position.set(0, 0, -12);
  car.group.rotation.set(0, 0, 0);
}

/** drive-into-a-building action. Economy screens open over the lobby; the Track gate leaves to the race. */
function triggerBuilding(kind: BuildingKind) {
  switch (kind) {
    case "garage": lobbyHud.hide(); garage.openGarage(); break;     // your car collection
    case "upgrades": lobbyHud.hide(); upgrades.open(); break;        // tune your car
    case "crates": lobbyHud.toast("Crate Shop — coming soon"); break; // Pillar 2, not built yet
    case "track": exitLobby(); break;                                // back to the race
  }
}

const mapBtn = createMapButton(hudRoot, () => {
  if (mode !== "race") return;
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

// Single sink for every ending — manual cash out, terminal-first flip/lever, and the crank poll.
// Freezes the local visual, sets the HUD outcome from the on-chain settled payload, fires FX, and
// refreshes the on-chain balance. Idempotent per round via `roundActive`.
function finalizeSettled(info: { outcome: number; outcomeName: string; payout: bigint }) {
  if (!roundActive) return;
  roundActive = false;
  const price = priceSource.price(), now = Date.now();
  if (engine.getPhase() === "live") engine.cashout(price, now); // freeze the visual at the live value
  const finalEq = engine.snapshot(price, now).equity;
  const liq = info.outcome === 2; // 0 cashout · 1 cap · 2 liq · 3 time
  const payoutUnits = Number(info.payout) / BASE_PER_UNIT; // un-floored centi-SOL → true 3-decimal SOL
  nearDeath = false;
  if (liq) deathsDoor.kill(); else deathsDoor.clear(); // Skull: shatter on liq, stand down otherwise (no-op off-Skull)
  autoExit.setLive(false); // Pink Rod panel: unlock for the next round
  // reset UI
  releaseHold();
  throttle = 34; game.equity = 1; chase.setDriving(false);
  garage.setBusy(false); mapBtn.setVisible(true); upgrades.setBusy(false); walletUI.setBusy(false);
  hud.setTimer(CONFIG.MAXSEC, false);
  controls.setLive(false, "GO!");
  hud.setMultiplier(Math.max(0, liq ? 0 : finalEq), liq ? "liquidated" : "settled");
  if (liq) {
    hud.setStatus("💥 Liquidated. Lost the play amount.");
    fx.liquidate(); audio.liquidate(); navigator.vibrate?.([30, 40, 30, 40, 90]);
  } else {
    hud.setStatus(`Settled at ×${finalEq.toFixed(2)}. Banked ${sol3(payoutUnits)}.`);
    fx.confetti(); audio.cashout(); navigator.vibrate?.(35);
  }
  void session.refreshBalance(session.delegated()).then(() => syncOnchainBalance()).catch(() => {});
}

// Authoritative on-chain close. On a confirmed close we finalize immediately; on an RPC hiccup we
// leave the round active so the crank/poll finalizes it (idempotent vs the crank).
async function closeRound(reason: "cashout" | "expire") {
  if (settling || !roundActive) return;
  settling = true;
  releaseHold();
  controls.setLive(true, "Settling…");
  try {
    const res = await session.close();
    finalizeSettled(res);
  } catch {
    controls.setLive(true, "CASH OUT");
    hud.setStatus("Close didn't confirm — the round will settle shortly.");
    void reason;
  } finally {
    settling = false;
  }
}

controls.onLaunch(async () => {
  if (mode === "lobby") return; // Space/Enter in the lot must not launch behind the scene
  audio.resume(); radio.resume();
  if (opening || settling || roundActive || engine.getPhase() === "live") return; // re-entrancy
  opening = true;
  // The round opens on whatever asset the BTC/ETH/SOL tabs have selected; the registry binds the
  // round to that asset's feed and `hud.onAsset` blocks switching once live, so the local engine's ×
  // (driven off priceSource for `asset`) reads the same feed the chain settles against.
  try {
    // First GO auto-starts the ER session (buy-in if empty + slice the bankroll + delegate).
    const playAmount = controls.playAmount(); // 0.01-SOL units — sizes the house slice for the round
    hud.setStatus("Getting on track…");
    try {
      await session.ensureSession(BUY_IN_BASE, unitsToBase(playAmount));
    } catch (e: any) {
      const friendly = e?.code === "delegate_busy" || e?.code === "bankroll_full";
      hud.setStatus(friendly ? e.message : "Couldn't start the round. Try again.");
      return;
    }
    await session.refreshBalance(true); syncOnchainBalance();

    if (session.balance() < BigInt(unitsToBase(playAmount))) {
      hud.setStatus("Add SOL to your play balance to race.");
      walletUI.open();
      return;
    }
    const dir = controls.dir();
    const lev = clampInt(game.lev, 10, 3000); // on-chain RMAX=3000
    hud.setStatus("Launching…");
    let opened;
    try {
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
      opened = await session.open(asset, dir, lev, unitsToBase(playAmount), Math.round(CONFIG.MAXSEC), Math.round(CONFIG.LIQ * 1_000_000), graceSecs, slFp, tpFp);
    } catch (e: any) {
      console.error("on-chain open failed", e);
      // HouseUndercapitalized is RaiderError #6005 — the on-chain error arrives as the raw
      // custom code ({"Custom":6005}), not the name, so match both.
      const emsg = String(e?.message ?? "");
      const drained = emsg.includes("HouseUndercapitalized") || emsg.includes("6005");
      if (drained) {
        // The house pot backing THIS run is spent (a hot streak drained it). Tear it down under
        // the hood so the next GO carves a fresh one — the player only ever sees "press GO", never
        // the session lifecycle. Best-effort: if the teardown fails, the next GO's adopt/reslice
        // path still recovers it.
        try { await session.endSession(); } catch (err) { console.warn("auto-reset after spent pot failed:", err); }
        syncOnchainBalance();
        hud.setStatus("Hot streak — that table's tapped out. Press GO for a fresh one.");
      } else {
        hud.setStatus("Couldn't start the round. Try again.");
      }
      controls.setLive(false, "GO!");
      return;
    }
    round.entryPx = opened.entryHuman; // human entry price (NOT the raw mantissa)
    round.dir = dir;
    lastStakeUnits = playAmount;
    roundStartMs = Date.now();
    engine.launch({ dir, lev, stake: playAmount, entryRaw: opened.entryHuman, startMs: roundStartMs });
    roundActive = true;
    nearDeath = false; deathsDoor.clear(); // fresh round → drop any lingering Skull near-death state
    autoExit.setLive(true); // Pink Rod panel: armed + locked (values stamped on-chain at open)
    chase.setDriving(true);
    controls.setLive(true, "CASH OUT");
    garage.setBusy(true); mapBtn.setVisible(false); upgrades.setBusy(true); walletUI.setBusy(true);
    hud.setStatus(session.crankArmed() ? "" : "⚠ auto-settle crank not armed — cash out manually.");
  } finally {
    opening = false;
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
  flipping = true;
  try {
    const res = await session.flip(dir);
    if (res.settled) finalizeSettled(res);
  } catch {
    /* keep playing; the local flip already applied and close() settles at on-chain truth */
  } finally {
    flipping = false;
  }
}

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
    lobbyHud.setPrompt(doorArmed ? hit : null);
    if (doorArmed && hit) {
      doorDwell += dt;
      if (doorDwell > 0.45) { doorDwell = 0; doorArmed = false; triggerBuilding(hit); }
    } else {
      doorDwell = 0;
      if (!hit) doorArmed = true; // re-arm once the car has cleared every doorway
    }

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
  if (solUsd > 0) hud.setSolUsd(solUsd);
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
  game.lev = clampInt(niceLev(tToLev(throttle, effRmax())) * boost, 10, 3000); // car base (≤1500) × nitro (2×), on-chain RMAX=3000
  tach.setThrottle(Math.min(1, (throttle / 100) * boost), game.lev); // needle pegs during nitro
  audio.engine(throttle / 100, gasOn || drivable); // rev drone tracks leverage (live only)
  if (drivable) { engine.setLeverage(game.lev, roundPrice); session.noteLeverage(game.lev); } // instant local + coalesced on-chain

  if (engine.getPhase() === "live") {
    const nowMs = Date.now();
    // The smooth ×, payout and liq-buffer are the LOCAL engine off the live feed (no server mark).
    // The on-chain Round is the money truth — surfaced by the crank poll + the authoritative close().
    const snap = engine.snapshot(roundPrice, nowMs);
    game.equity = snap.equity;
    hud.setMultiplier(Math.max(0, snap.equity), "live");
    controls.setBuffer(Math.max(0, Math.min(1, snap.buffer)));
    // Skull "Death's Door": arm as equity nears the liq floor, disarm once clearly recovered.
    if (ability === "skull") {
      if (!nearDeath && snap.buffer <= 0.10) nearDeath = true;
      else if (nearDeath && snap.buffer >= 0.22) nearDeath = false;
      deathsDoor.danger(nearDeath);
    }
    hud.setTimer(CONFIG.MAXSEC - (nowMs - roundStartMs) / 1000, true);
    car.setEquity("live", Math.max(0, snap.equity));
    controls.setLive(true, `${snap.equity >= 1 ? "CASH OUT" : "BAIL"} ${sol3(snap.payout)}`, snap.equity < 1);
    // Local 60s backstop: the native crank normally settles first; this closes on-chain if it lags.
    if (roundActive && !settling && (nowMs - roundStartMs) / 1000 >= CONFIG.MAXSEC) void closeRound("expire");
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
// Poll the on-chain Round ~1.5×/s so a crank/keeper settlement surfaces even if the player never taps.
// setInterval (not rAF) because rAF is throttled hard in Claude Preview.
let polling = false;
setInterval(async () => {
  if (!roundActive || settling || polling || !session.delegated()) return;
  polling = true;
  try {
    const snap = await session.poll();
    if (snap && snap.status === 2) finalizeSettled(snap);
  } catch { /* transient RPC — keep last */ }
  finally { polling = false; }
}, 650);

requestAnimationFrame(frame);
// Login gate — created LAST so createHud's `hudRoot.innerHTML = …` can't wipe it. The
// wallet connects + the session starts ONLY on "Sign in"; Log out (garage menu) re-shows it.
const authGate = createAuthGate(document.body);
authGate.onSignIn(async () => {
  authGate.setBusy(true);
  try {
    await session.init();
    syncOnchainBalance();
    authGate.hide();
  } catch (e) {
    console.error("sign-in failed", e);
    authGate.setError("Sign-in failed — check your connection and try again.");
  }
});

console.log("redline3d render up");
