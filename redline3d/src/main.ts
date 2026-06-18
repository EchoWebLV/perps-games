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
import type { Snapshot } from "./core/types";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;

const ctx = createScene(canvas);

// quality / post-processing (perf-gated)
const quality = detectQuality();
ctx.renderer.setPixelRatio(Math.min(quality.pixelRatioCap, window.devicePixelRatio || 1));
const post = quality.bloom ? createPost(ctx.renderer, ctx.scene, ctx.camera) : null;
addEventListener("resize", () => post?.setSize(window.innerWidth, window.innerHeight));

// world + car
const world = createWorld();
ctx.scene.add(world.group);
const car = createCar();
car.group.position.set(0, 0, -4);
ctx.scene.add(car.group);
const chase = createChaseCam();

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

// ui
const hud = createHud(hudRoot);
const tach = createTach(hudRoot);
const controls = createControls(hudRoot);
hud.setBalance(wallet.balance());

const game = { lev: tach.lev(), equity: 1 };

tach.onChange((lev) => {
  game.lev = lev;
  if (engine.getPhase() === "live") engine.setLeverage(lev, priceSource.price());
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
  engine.launch({ dir: controls.dir(), lev: tach.lev(), stake, entryRaw: entry, startMs: Date.now() });
  controls.setLive(true, "CASH OUT");
  hud.setStatus(`Riding ${controls.dir() > 0 ? "LONG" : "SHORT"} SOL at ${tach.lev()}× from $${entry.toFixed(2)}.`);
});

controls.onCashout(() => {
  if (engine.getPhase() !== "live") return;
  endRound(engine.cashout(priceSource.price(), Date.now()));
});

function frame() {
  const dt = ctx.clock.getDelta();
  const price = priceSource.price();
  hud.setPrice(price, priceSource.live());

  if (engine.getPhase() === "live") {
    const snap = engine.tick(price, Date.now());
    game.equity = snap.equity;
    if (snap.phase !== "live") {
      endRound(snap);
    } else {
      hud.setMultiplier(snap.equity, snap.phase);
      hud.setBuffer(snap.buffer, true);
      car.setEquity("live", snap.equity);
      controls.setLive(true, `CASH OUT $${snap.payout.toFixed(2)}`);
    }
  } else {
    car.setEquity("idle", 1);
  }

  const speed = chase.update(ctx.camera, dt, game.lev, game.equity, engine.getPhase() === "live");
  world.update(dt, speed);
  car.update(dt);

  if (post) post.render();
  else ctx.renderer.render(ctx.scene, ctx.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
console.log("redline3d render up");
