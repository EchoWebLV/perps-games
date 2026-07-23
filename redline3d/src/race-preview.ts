// Spectator-race preview (DEV-ONLY, not part of the game — modelled on src/lobby-preview.ts).
// Four AI cars run three laps of a standalone neon circuit (src/render/race-track.ts) with a
// SCRIPTED outcome, wrapped in a fake prediction market (src/ui/bet-panel.ts).
//
// PACING (no random slowdowns): a seeded RNG picks the finish order from rarity stats (upsets
// possible) and a target finish time T_i per car (winner smallest, ~1.2s gaps). Every car runs a
// CONSTANT base speed, scaled by a UNIVERSAL cornering factor (same curve for everyone → reads as
// physics, not rubber-banding) plus its own POSITIVE overtake surges (smooth ease-in/out boosts;
// a car being passed never decelerates). base_i is solved so the finish time is exactly T_i:
// since speed = base·factor(s)·(1+surge), time = (1/base)·∫ ds/(factor·(1+surge)), so
// base_i = C_i/T_i with C_i integrated numerically once at setup → order is guaranteed.
//
// Own WebGLRenderer/Scene/PerspectiveCamera + a resilient ticker; race-preview.html is not a vite
// build input, so this stays a dev harness. Nothing here is wired into the game.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { carNormScale, REF_LEN } from "./render/car-scale";
import { buildWheelRig, type WheelRig } from "./render/wheels";
import { tierOf, type Rarity } from "./core/rarity";
import { createRaceTrack } from "./render/race-track";
import { createRaceEnvironment } from "./render/race-environment";
import { toonify } from "./render/toon";
import { createRaceDirector, type DirectorCar, type DirectorMode } from "./render/race-director";
import { createRaceHud, type RacePhase } from "./ui/race-hud";
import { createBetPanel } from "./ui/bet-panel";
import { createCamControls } from "./ui/cam-controls";

// ── 8-car roster: literals copied from CAR_DEFS (main.ts) — do NOT import main.ts (it boots the
// game). Small files, wide rarity spread so the market reads well. ────────────────────────────
interface RaceSpec { name: string; rarity: Rarity; url: string; scale?: number; yaw?: number }
const SPECS: RaceSpec[] = [
  { name: "Bedrock", rarity: 5, url: "/models/flintstone.glb", scale: 0.7 },        // 5.3MB legendary
  { name: "DeLorean", rarity: 4, url: "/models/delorean.glb" },                     // 4.2MB epic
  { name: "Cybertruck", rarity: 3, url: "/models/cybertruck.glb", scale: 1.3 },     // 0.4MB rare
  { name: "Vaporwave", rarity: 3, url: "/models/vaporwave.glb" },                   // 1.1MB rare
  { name: "Prickle", rarity: 2, url: "/models/cactus.glb", yaw: Math.PI / 2 },      // 10MB uncommon
  { name: "Knockout", rarity: 3, url: "/models/knockout.glb", yaw: Math.PI / 2 },   // 4.8MB rare
  { name: "Big Frank", rarity: 1, url: "/models/wiener.glb", yaw: Math.PI / 2 },    // 3.4MB common
  { name: "Trabant", rarity: 1, url: "/models/trabant.glb", yaw: Math.PI / 2 },     // 3.7MB common underdog
];

// facing convention copied from cruisers.ts / car.ts: MODEL_YAW + per-car yaw makes every GLB
// face -Z, and track.poseAt()'s rot aligns the anchor's -Z with the racing-line tangent.
const MODEL_YAW = Math.PI;
const TOTAL_LAPS = 3;
// 8 distinct lateral lanes across the wide road (HALF_W 18); kept off the last ~3 units near edges.
const LANE_OFF = [-14.5, -10.3, -6.2, -2.0, 2.0, 6.2, 10.3, 14.5];
// 2 staggered rows of 4 at the grid: even lanes start abreast, odd lanes sit a car-length back.
// A constant longitudinal render offset (not the sim distance) keeps the pack visually staggered.
const GRID_STAGGER = -13;
const BASE_T = 30;          // winner finish time (s) → ~10s/lap; losers spaced by GAP
const GAP = 0.8;            // tighter gaps for an 8-car pack
const MARKET_TIME = 15;     // MARKET OPEN window (s)
const CD_TIME = 3.0;
const GO_HOLD = 0.8;
const FINISH_HOLD = 6.0;
const SUB_H = 1 / 240;      // fixed sim sub-step for framerate-independent, exact finish times

const STRENGTH: Record<Rarity, number> = { 1: 1.0, 2: 1.35, 3: 1.8, 4: 2.4, 5: 3.2 };
const OUTCOME_NOISE = 2.8;  // additive seeded spread — big enough that a common can upset a legendary

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const vw = () => innerWidth || 1280;
const vh = () => innerHeight || 800;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(vw(), vh());
renderer.toneMapping = THREE.ACESFilmicToneMapping; // cinematic response — the big "flat neon" fix
renderer.toneMappingExposure = 1.05; // moody-noir: darkness is the canvas, neon is the paint
renderer.domElement.style.display = "block";
renderer.domElement.style.width = "100vw";
renderer.domElement.style.height = "100vh";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05030f);
scene.fog = new THREE.Fog(0x0a0518, 210, 760); // dark violet depth haze
// near/far tightened for depth-buffer precision (the road decals stack in <1u of vertical range):
// near 2 (camera never gets closer — clearance keeps it ≥8 from cars), far just past the sky dome.
const camera = new THREE.PerspectiveCamera(55, vw() / vh(), 2, 4000);
camera.position.set(0, 130, 210);
camera.lookAt(0, 0, 0);

const track = createRaceTrack();
scene.add(track.group);
const environment = createRaceEnvironment(track);
scene.add(environment.group);
const lapLen = track.length;
const raceDist = TOTAL_LAPS * lapLen;

// lighting (added to OUR scene only) so the metallic cars read richly against the dark circuit
// PMREM environment map (same pattern as the game's garage-room.ts) → real reflections on car paint
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x120a24, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.15); // key for shape
key.position.set(80, 150, 60);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6ab8ff, 0.55);  // cool rim from the skyline side
rim.position.set(-120, 60, -120);
scene.add(rim);

// ── bloom post-processing (the defining look for the neon aesthetic) ─────────────────────────
const composer = new EffectComposer(renderer);
composer.renderTarget1.samples = 4;
composer.renderTarget2.samples = 4;
composer.addPass(new RenderPass(scene, camera));
// strength / radius / threshold tuned so neon edges glow but the env-lit cars don't blow out
const bloom = new UnrealBloomPass(new THREE.Vector2(vw(), vh()), 0.62, 0.4, 0.62);
composer.addPass(bloom);

const director = createRaceDirector(camera, track);

// ── manual camera: mode strip + OrbitControls for FREE mode ──────────────────────────────────
const camControls = createCamControls(SPECS.length);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 25;
orbit.maxDistance = track.boundingRadius + 400;
orbit.maxPolarAngle = Math.PI * 0.49; // can't dip under the floor
orbit.enabled = false;
orbit.target.set(track.center.x, 2, track.center.z);
camControls.onModeChange((m) => {
  orbit.enabled = m === "FREE";
  if (m === "FREE") { orbit.target.copy(packCentroid()); orbit.update(); }
});
// a pointer-drag on the canvas in a non-FREE mode hands control to FREE
let dragStart: { x: number; y: number } | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => { dragStart = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!dragStart || camControls.mode() === "FREE") return;
  if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 6) camControls.setMode("FREE");
});
addEventListener("pointerup", () => { dragStart = null; });

function packCentroid(): THREE.Vector3 {
  const v = new THREE.Vector3();
  for (const c of cars) v.add(c.anchor.position);
  return v.multiplyScalar(1 / cars.length);
}

// ── per-car runtime state ───────────────────────────────────────────────────────────────────
interface Surge { start: number; len: number; amp: number } // distance window over the full race
interface RaceCar {
  spec: RaceSpec;
  color: string;
  anchor: THREE.Group;
  rig: WheelRig | null;
  laneOff: number;
  dOffset: number;       // constant longitudinal RENDER offset (grid stagger) — not the sim distance
  base: number;          // calibrated constant base speed (world units/s)
  surges: Surge[];
  T: number;             // target finish time
  dist: number;          // arc-length traveled [0, raceDist]
  speed: number;         // current world speed (corner + surge modulated)
  finished: boolean;
  finishT: number;
}

// shared additive glow sprite for car taillights (so the pack reads at distance under bloom)
const tailTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,60,60,1)"); grd.addColorStop(0.4, "rgba(255,40,40,0.5)"); grd.addColorStop(1, "rgba(255,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
// shared soft blob-shadow texture (dark radial gradient) to ground each car
const shadowTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(0,0,0,0.55)"); grd.addColorStop(0.6, "rgba(0,0,0,0.28)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const shadowGeo = new THREE.PlaneGeometry(1, 1);

const cars: RaceCar[] = SPECS.map((spec, i) => {
  const anchor = new THREE.Group();
  scene.add(anchor);
  // soft blob shadow flat on the ground under the car (unlit road won't show real shadows)
  const blob = new THREE.Mesh(shadowGeo, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.9 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.06;
  blob.scale.set(9, 15, 1); // footprint-ish (x width, y = length along -Z)
  anchor.add(blob);
  // two taillight glows at the rear (car noses -Z, so rear is +Z after MODEL_YAW)
  for (const sx of [-1.6, 1.6]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tailTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.scale.set(2.4, 2.4, 1);
    s.position.set(sx, 1.1, 3.4);
    anchor.add(s);
  }
  return {
    spec, color: tierOf(spec.rarity).color, anchor, rig: null,
    laneOff: LANE_OFF[i], dOffset: (i % 2 === 0) ? 0 : GRID_STAGGER, base: 60, surges: [], T: BASE_T,
    dist: 0, speed: 0, finished: false, finishT: 0,
  };
});

const hud = createRaceHud();
const betPanel = createBetPanel();
const roster = cars.map((c, i) => ({ id: i, name: c.spec.name, color: c.color }));
hud.setRoster(roster);
betPanel.setRoster(roster);

// tap a leaderboard row → focus that car (toggle: tapping the focused row returns to Leader+AUTO).
// Shares one focus state with the camera bar's FOCUS cycle.
hud.onRowTap((id) => {
  const focused = camControls.focusSel() !== "leader" && resolveFocus() === id;
  const mode = camControls.mode();
  if (focused && mode !== "FREE") {
    camControls.setFocusCar(-1);   // back to Leader
    camControls.setMode("AUTO");
  } else {
    camControls.setFocusCar(id);
    if (mode === "AUTO") camControls.setMode("CHASE"); // FREE/CHASE/TV/DRONE keep their mode, just re-subject
  }
});

let phase: RacePhase = "LOADING";
let seed = (Math.random() * 1e9) | 0;

// ── scripted-outcome pacing ─────────────────────────────────────────────────────────────────
function surgeBoost(car: RaceCar, d: number): number {
  let b = 0;
  for (const s of car.surges) {
    const x = (d - s.start) / s.len;
    if (x > 0 && x < 1) { const e = Math.sin(Math.PI * x); b += s.amp * e * e; } // 0→1→0 ease
  }
  return b;
}

// C_i = ∫₀^raceDist ds / (cornerFactor(s) · (1+surge_i(s))); base_i = C_i / T_i (exact finish time)
function calibrateBase(car: RaceCar): number {
  const STEPS = 6000;
  const dd = raceDist / STEPS;
  let C = 0;
  for (let k = 0; k < STEPS; k++) {
    const d = (k + 0.5) * dd;
    const factor = track.cornerFactorAt(d % lapLen);
    C += dd / (factor * (1 + surgeBoost(car, d)));
  }
  return C / car.T;
}

// positive overtake surges per finish-rank across the 8-car field — battles throughout, not just
// P1. Winner takes the lead with a late charge; others surge on different laps so leads swap.
function surgesForRank(rank: number, rng: () => number): Surge[] {
  const jA = () => (rng() - 0.5) * 0.06;
  const jS = () => (rng() - 0.5) * 0.10 * lapLen;
  const S = (lap: number, frac: number, amp: number): Surge => ({ start: (lap + frac) * lapLen + jS(), len: 0.38 * lapLen, amp: amp + jA() });
  switch (rank) {
    case 0: return [S(2, 0.15, 0.40)];              // winner — late charge into the lead (lap 3)
    case 1: return [S(0, 0.45, 0.34)];              // early leader that fades (lap 1)
    case 2: return [S(1, 0.30, 0.32)];              // mid-race surge (lap 2)
    case 3: return [S(0, 0.70, 0.30), S(2, 0.50, 0.24)]; // two pushes
    case 4: return [S(1, 0.65, 0.30)];              // mid-pack scrap (lap 2)
    case 5: return [S(2, 0.05, 0.28)];              // last-lap pack move
    default: return [];                              // rank 6-7 hold base
  }
}

function setupRace(): number[] {
  const rng = mulberry32(seed);
  const strengths = cars.map((c) => STRENGTH[c.spec.rarity]);
  // hidden seeded score = strength + noise → sort desc for the finish order (rank 0 wins)
  const scored = cars.map((_c, i) => ({ i, score: strengths[i] + rng() * OUTCOME_NOISE }));
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((sc, rank) => {
    const c = cars[sc.i];
    c.T = BASE_T + rank * GAP + rng() * 0.4;
    c.surges = surgesForRank(rank, rng);
    c.dist = 0; c.speed = 0; c.finished = false; c.finishT = 0;
  });
  for (const c of cars) c.base = calibrateBase(c);
  maxRefSpeed = Math.max(...cars.map((c) => c.base)) * 1.45; // reference top speed for the FOV kick
  return strengths;
}
let maxRefSpeed = 90;

// ── phase machine ───────────────────────────────────────────────────────────────────────────
let marketTimer = MARKET_TIME;
let cdRemaining = CD_TIME;
let goFlash = 0;
let raceElapsed = 0;
let finishTimer = 0;
let simAccum = 0;

function enterMarket() {
  const strengths = setupRace();
  betPanel.openMarket(seed, strengths);
  phase = "MARKET";
  marketTimer = MARKET_TIME;
  simAccum = 0; raceElapsed = 0;
  director.reset();
}

function lockAndCountdown() {
  betPanel.lock();
  phase = "COUNTDOWN";
  cdRemaining = CD_TIME;
  goFlash = 0;
}

function enterFinish() {
  phase = "FINISH";
  finishTimer = FINISH_HOLD;
  const winner = order()[0];
  betPanel.settle(winner);
}

function restart() {
  seed = (Math.random() * 1e9) | 0;
  enterMarket();
}
betPanel.onRaceAgain(restart);
betPanel.onSkip(lockAndCountdown);

function advance(h: number) {
  raceElapsed += h;
  for (const c of cars) {
    if (c.finished) { c.speed = 0; continue; }
    const factor = track.cornerFactorAt(c.dist % lapLen);
    c.speed = c.base * factor * (1 + surgeBoost(c, c.dist));
    c.dist += c.speed * h;
    if (c.dist >= raceDist) { c.dist = raceDist; c.finished = true; c.finishT = raceElapsed; c.speed = 0; }
  }
}

function step(dt: number) {
  if (phase === "MARKET") {
    marketTimer -= dt;
    betPanel.tick(dt);
    if (marketTimer <= 0) lockAndCountdown();
  } else if (phase === "COUNTDOWN") {
    cdRemaining -= dt;
    if (cdRemaining <= 0) { phase = "RACING"; goFlash = GO_HOLD; }
  } else if (phase === "RACING") {
    if (goFlash > 0) goFlash -= dt;
    simAccum += dt;
    let guard = 0;
    while (simAccum >= SUB_H && guard < 4000) { advance(SUB_H); simAccum -= SUB_H; guard++; }
    if (cars.every((c) => c.finished)) enterFinish();
  } else if (phase === "FINISH") {
    finishTimer -= dt;
    if (finishTimer <= 0) restart();
  }
}

function placeCars(dt: number) {
  for (const c of cars) {
    // dOffset is a constant RENDER-only grid stagger (2 rows of 4); order/finish use c.dist
    const p = track.poseAt(c.dist + c.dOffset, c.laneOff);
    c.anchor.position.set(p.x, 0, p.z);
    c.anchor.rotation.y = p.rot;
    c.rig?.spin(dt, c.speed); // wheel roll at actual current speed
  }
}

// order: finished cars first (by finish time), then the rest by distance covered
function order(): number[] {
  return cars.map((_c, i) => i).sort((a, b) => {
    const ca = cars[a], cb = cars[b];
    if (ca.finished && cb.finished) return ca.finishT - cb.finishT;
    if (ca.finished) return -1;
    if (cb.finished) return 1;
    return cb.dist - ca.dist;
  });
}

function leaderDist(): number {
  let m = 0;
  for (const c of cars) if (c.dist > m) m = c.dist;
  return m;
}

function currentLap(): number {
  return Math.min(TOTAL_LAPS, Math.floor(leaderDist() / lapLen) + 1);
}

function countdownLabel(): string | null {
  if (phase === "COUNTDOWN") return String(Math.max(1, Math.ceil(cdRemaining)));
  if (phase === "RACING" && goFlash > 0) return "GO";
  return null;
}

// ── camera: manual modes (AUTO/CHASE/TV/DRONE via director, FREE via OrbitControls) ─────────
function resolveFocus(): number {
  const sel = camControls.focusSel();
  const ord = order();
  if (sel === "leader") return ord[0];
  if (sel === "mybet") { const mb = betPanel.myBet(); return mb >= 0 ? mb : ord[0]; }
  return sel;
}
function focusLabel(): string {
  const sel = camControls.focusSel();
  if (sel === "leader") return "Leader";
  if (sel === "mybet") { const mb = betPanel.myBet(); return mb >= 0 ? `My Bet · ${cars[mb].spec.name}` : "My Bet"; }
  return cars[sel].spec.name;
}
function runDirector(dt: number) {
  const mode = camControls.mode();
  camControls.setFocusLabel(focusLabel());
  if (mode === "FREE") {
    // orbit target follows the focused car if one is picked, else the whole pack (both damped)
    const tgt = camControls.focusSel() !== "leader" ? cars[resolveFocus()].anchor.position : packCentroid();
    orbit.target.lerp(tgt, 0.05);
    orbit.update();
    return;
  }
  const dirCars: DirectorCar[] = cars.map((c) => ({
    dist: c.dist, laneOff: c.laneOff, pos: c.anchor.position,
    speed: c.speed, surges: c.surges, finished: c.finished,
  }));
  director.aim(dt, {
    phase, cars: dirCars, order: order(), raceDist, maxSpeed: maxRefSpeed,
    mode: mode as DirectorMode, focus: resolveFocus(), myBet: betPanel.myBet(),
  });
}

// ── HUD / bet-panel push ────────────────────────────────────────────────────────────────────
function pushUi(dt: number) {
  const ord = order();
  hud.render({
    phase,
    order: ord,
    leaderId: phase === "RACING" || phase === "FINISH" ? ord[0] : null,
    focusId: camControls.focusSel() !== "leader" ? resolveFocus() : null,
    lap: phase === "LOADING" || phase === "MARKET" ? 1 : currentLap(),
    totalLaps: TOTAL_LAPS,
    countdown: countdownLabel(),
  });
  betPanel.render({
    phase,
    marketRemaining: marketTimer,
    raceLeaderName: phase === "RACING" ? cars[ord[0]].spec.name : null,
  });
  void dt;
}

// verification hook (dev harness — no guard needed)
(window as unknown as { __raceState: () => unknown }).__raceState = () => ({
  phase,
  seed,
  lap: phase === "RACING" || phase === "FINISH" ? currentLap() : 0,
  order: order().map((i) => cars[i].spec.name),
  speeds: cars.map((c) => +c.speed.toFixed(2)),
  wallet: +betPanel.wallet().toFixed(2),
  pool: +betPanel.poolTotal().toFixed(2),
  mode: camControls.mode(),
  drawCalls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
});

// dev time-warp: fast-forward the sim through the SAME per-frame update path (fixed dt) so laps,
// order, finish detection, the FINISH transition and bet settlement all fire exactly as in real
// time. No-op during MARKET (can't skip betting); stops the instant it reaches FINISH so the
// settlement state is observable. Rendering is skipped in the loop and done once at the end.
(window as unknown as { __warp: (sec: number) => unknown }).__warp = (sec: number) => {
  if (phase === "MARKET" || phase === "LOADING") return { skipped: phase };
  const steps = Math.max(1, Math.round(sec * 60));
  for (let i = 0; i < steps; i++) { step(1 / 60); if (phase === "FINISH") break; }
  placeCars(1 / 60);
  runDirector(1 / 60);
  track.update(1 / 60);
  environment.update(1 / 60);
  pushUi(1 / 60);
  composer.render();
  return { phase, order: order().map((i) => cars[i].spec.name), wallet: +betPanel.wallet().toFixed(2) };
};

// ── resilient frame scheduler (this preview pane can fire rAF ZERO times) ────────────────────
function nextFrame(run: () => void): void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(rafId);
    clearTimeout(toId);
    run();
  };
  const rafId = requestAnimationFrame(fire);
  const toId = setTimeout(fire, 33);
}

function warm(model: THREE.Object3D): Promise<unknown> {
  const compiled = renderer.compileAsync(model, camera, scene).catch(() => undefined);
  const timeout = new Promise<void>((res) => setTimeout(res, 1500));
  return Promise.race([compiled, timeout]);
}

// ── GLB loading (after the first frame; sequential; shader-warmed before attach) ─────────────
const loader = new GLTFLoader();
function loadCar(car: RaceCar): Promise<void> {
  return new Promise((done) => {
    loader.load(car.spec.url, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = carNormScale(size, REF_LEN, car.spec.scale ?? 1);
      model.scale.setScalar(scale);
      model.rotation.y = MODEL_YAW + (car.spec.yaw ?? 0);
      const box2 = new THREE.Box3().setFromObject(model);
      const c = box2.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -box2.min.y, -c.z);
      void warm(model).then(() => {
        const savedRot = car.anchor.rotation.y;
        car.anchor.rotation.y = 0;
        car.anchor.add(model);
        car.anchor.updateMatrixWorld(true);
        car.rig = buildWheelRig(model, scale, { probe: false });
        car.anchor.rotation.y = savedRot;
        toonify(model, { outlineWidth: 0.3 }); // cel-shade + bold outline (reads at chase distance)
        done();
      });
    }, undefined, (err) => { console.warn("[race-preview] GLB failed:", car.spec.url, err); done(); });
  });
}

// ── boot: HUD + market panel up immediately, load cars after 2 frames, then open the market ──
nextFrame(() => nextFrame(async () => {
  for (const c of cars) await loadCar(c);
  enterMarket();
}));

addEventListener("resize", () => {
  renderer.setSize(vw(), vh());
  camera.aspect = vw() / vh();
  camera.updateProjectionMatrix();
  composer.setSize(vw(), vh());
  bloom.setSize(vw(), vh());
});

let last = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000); // clamp so a long stall never teleports cars
  last = now;
  step(dt);
  placeCars(dt);      // update world poses first so the director frames current positions
  runDirector(dt);
  track.update(dt);
  environment.update(dt);
  pushUi(dt);
  composer.render();  // bloom composite
  nextFrame(loop);
}
nextFrame(loop);
