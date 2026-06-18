import { createScene } from "./render/scene";
import { createWorld } from "./render/world";
import { createCar } from "./render/car";
import { createChaseCam } from "./render/camera";
import { detectQuality } from "./platform/perf";
import { createPost } from "./render/post";
import { createHud } from "./ui/hud";
import { createTach } from "./ui/tach";
import { createControls } from "./ui/controls";
import { connectFeed } from "./core/feed";
import { createPriceSource } from "./core/price-source";
import { RoundEngine } from "./core/round";
import { SimSettlement } from "./core/settlement";
import { niceLev, tToLev } from "./core/leverage";
import { liqPriceOf } from "./core/economics";
import { CONFIG } from "./core/config";
import { createMinimap } from "./ui/minimap";
import { createPickups } from "./render/pickups";
import type { Snapshot } from "./core/types";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;

const ctx = createScene(canvas);

// quality / post-processing (perf-gated)
const quality = detectQuality();
ctx.renderer.setPixelRatio(Math.min(quality.pixelRatioCap, window.devicePixelRatio || 1));
const post = quality.bloom ? createPost(ctx.renderer, ctx.scene, ctx.camera) : null;
addEventListener("resize", () => {
  ctx.resize(window.innerWidth, window.innerHeight);
  post?.setSize(window.innerWidth, window.innerHeight);
});

// world + car
const world = createWorld();
ctx.scene.add(world.group);
const car = createCar();
car.group.position.set(0, 0, -12);
ctx.scene.add(car.group);
const chase = createChaseCam();
const pickups = createPickups();
ctx.scene.add(pickups.group);

// core
const engine = new RoundEngine();
const wallet = new SimSettlement();

// price feed
const SOL = { key: "SOL", lz: 6, hx: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8 };
const priceSource = createPriceSource({
  connect: (onPrice) => {
    const h = connectFeed({ feeds: [SOL], onPrice: (_k, v) => onPrice(v) });
    return () => h.stop();
  },
});
addEventListener("pagehide", () => priceSource.stop());

// ui
const hud = createHud(hudRoot);
const tach = createTach(hud.tachMount);
const controls = createControls(hud.ctrlMount, hud.goMount, hud.pedalMount);
const minimap = createMinimap(hud.miniCanvas);
hud.setBalance(wallet.balance());
hud.setCoins(0);

// throttle = the accelerator: gas revs it up, brake slows it, release coasts down SLOWLY
let throttle = 34; // 0..100 (starts ~50x)
const GAS = 52, BRAKE = 78, COAST = 6;
const game = { lev: niceLev(tToLev(throttle)), equity: 1 };
let lastLivePrice = 0;
let solSmooth = 0; // eased display price → a flowing minimap curve (raw price drives economics)
let solEMA = 0;    // slow average; price vs this drives the terrain elevation

// price history (minimap), coins, lateral steering, and the active round's entry
const priceHist: number[] = [];
let coins = 0;
let carX = 0, carXTarget = 0;
const round = { entryPx: 0, dir: 1 as 1 | -1 };

// touch steering: drag horizontally on the road to move the car
let dragging = false;
canvas.addEventListener("pointerdown", () => { dragging = true; });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e) => {
  if (dragging) carXTarget = Math.max(-10, Math.min(10, ((e.clientX - innerWidth / 2) / (innerWidth / 2)) * 11));
});

function endRound(snap: Snapshot) {
  wallet.credit(snap.payout);
  hud.setBalance(wallet.balance());
  game.equity = 1;
  controls.setLive(false, "🚀 LAUNCH");
  hud.setBuffer(0, false);
  hud.setMultiplier(snap.equity, snap.phase);
  if (snap.phase === "liquidated") hud.setStatus(`💥 Liquidated at ${snap.lev}×. Lost your stake.`);
  else hud.setStatus(`Settled at ×${snap.equity.toFixed(2)} — banked $${snap.payout.toFixed(2)} (${snap.reason}).`);
}

controls.onLaunch(() => {
  const stake = controls.stake();
  if (!wallet.canAfford(stake)) { hud.setStatus("Not enough balance — lower your stake."); return; }
  const entry = priceSource.price();
  if (!entry) { hud.setStatus("Waiting for the SOL feed…"); return; }
  wallet.debit(stake);
  hud.setBalance(wallet.balance());
  round.entryPx = entry;
  round.dir = controls.dir();
  engine.launch({ dir: controls.dir(), lev: game.lev, stake, entryRaw: entry, startMs: Date.now() });
  controls.setLive(true, "CASH OUT");
  hud.setStatus(`Riding ${controls.dir() > 0 ? "LONG" : "SHORT"} SOL at ${game.lev}× from $${entry.toFixed(2)}.`);
});

controls.onCashout(() => {
  if (engine.getPhase() !== "live") return;
  endRound(engine.cashout(priceSource.price(), Date.now()));
});

function frame() {
  const dt = ctx.clock.getDelta();
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

  // accelerator with momentum: gas revs up, brake slows, release coasts down slowly
  if (controls.gas()) throttle += GAS * dt;
  else if (controls.brake()) throttle -= BRAKE * dt;
  else throttle -= COAST * dt;
  throttle = Math.max(0, Math.min(100, throttle));
  game.lev = niceLev(tToLev(throttle));
  tach.setThrottle(throttle / 100, game.lev);
  if (engine.getPhase() === "live") engine.setLeverage(game.lev, roundPrice);

  if (engine.getPhase() === "live") {
    const snap = engine.tick(roundPrice, Date.now());
    game.equity = snap.equity;
    if (snap.phase !== "live") {
      endRound(snap);
    } else {
      hud.setMultiplier(snap.equity, snap.phase);
      hud.setBuffer(snap.buffer, true);
      car.setEquity("live", snap.equity);
      const win = snap.equity >= 1;
      controls.setLive(true, `${win ? "CASH OUT" : "BAIL"} $${snap.payout.toFixed(2)}`, !win);
    }
  } else {
    car.setEquity("idle", 1);
  }

  // lateral steering (arrows + touch drag), with the car leaning into the turn
  carXTarget += controls.steer() * 22 * dt;
  carXTarget = Math.max(-10, Math.min(10, carXTarget));
  carX += (carXTarget - carX) * 0.18;

  const live2 = engine.getPhase() === "live";
  // price-driven terrain bias: road climbs when SOL is above its average, dips when below
  const hill = Math.max(-7, Math.min(7, (solEMA ? solSmooth / solEMA - 1 : 0) * 2600));
  const speed = chase.update(ctx.camera, dt, throttle / 100, game.equity, live2);
  world.update(dt, speed, hill);

  // everything rides the road surface (which rises on a pump, dips on a dump)
  const surf = world.surfaceY(-12);
  ctx.camera.position.y += surf * 0.55;
  car.update(dt);
  car.group.position.x = carX;
  car.group.position.y += surf;
  const lean = controls.steer() !== 0 ? -controls.steer() * 0.2 : -(carXTarget - carX) * 0.05;
  car.group.rotation.z = Math.max(-0.3, Math.min(0.3, lean));

  // collectible coins: steer into them for a coin (and a small banked bonus mid-run)
  const got = pickups.update(dt, speed, carX, world.surfaceY);
  if (got) {
    coins += got;
    hud.setCoins(coins);
    if (live2) engine.addBonus(0.04 * got);
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
