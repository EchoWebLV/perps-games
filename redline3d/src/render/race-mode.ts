// Shared spectator-race sim, extracted from src/race-preview.ts so the dev harness AND the in-app
// "grand prix" mode can drive the SAME code. This module owns everything race-specific: the track +
// environment groups, the per-car pacing sim, the phase machine, the camera director, and the HUD /
// bet-panel / cam-controls DOM. It does NOT own the renderer, composer, post-processing, scene
// lights/fog, OrbitControls or the rAF loop — the HOST keeps those and calls `update(dt)` each frame
// then renders. Everything the module adds to the scene it also removes in `dispose()`.
//
// PACING (unchanged from the prototype): a seeded RNG picks the finish order from grid strengths
// (upsets possible) and a target finish time T_i per car (winner smallest, ~0.8s gaps). Every car
// runs a CONSTANT base speed, scaled by a UNIVERSAL cornering factor (same curve for everyone → reads
// as physics, not rubber-banding) plus its own POSITIVE overtake surges. base_i is solved so the
// finish time is exactly T_i: since speed = base·factor(s)·(1+surge), time = (1/base)·∫ ds/(factor·
// (1+surge)), so base_i = C_i/T_i with C_i integrated numerically once at setup → order is guaranteed.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { carNormScale, REF_LEN } from "./car-scale";
import { buildWheelRig, type WheelRig } from "./wheels";
import { tierOf } from "../core/rarity";
import { createRaceTrack } from "./race-track";
import { createRaceEnvironment } from "./race-environment";
import { toonify, reclaimToonVariants } from "./toon";
import { createRaceDirector, type DirectorCar, type DirectorMode } from "./race-director";
import { createRaceHud, type RacePhase } from "../ui/race-hud";
import { createBetPanel } from "../ui/bet-panel";
import { createCamControls } from "../ui/cam-controls";
import { onTap } from "../ui/tap";
import { STRENGTH, type GridEntrant } from "../core/race-grid";

// ── public surface ────────────────────────────────────────────────────────────────────────────
export interface RaceGameOptions {
  scene: THREE.Scene;                 // race group + environment are added/removed here
  camera: THREE.PerspectiveCamera;    // the director aims this
  hudParent: HTMLElement;             // race-hud / bet-panel / cam-controls mount here
  grid: GridEntrant[];                // from buildGrid(); player car may be grid[0]
  seed: number;                       // race outcome seed (mulberry32)
  // Quality tier (mirrors main.ts quality.detail). RESERVED for the in-app host: Task 7 threads it
  // through to gate render cost; unread today. Keep it in the interface so T7 needn't reshape the API.
  lowTier: boolean;
  devHooks?: boolean;                 // install window.__raceState / __warp (harness only)
  onExit?: (result: RaceResult) => void; // fired when the player leaves after FINISH
}
export interface RaceResult {
  finishOrder: number[];              // grid indices, winner first
  playerRank: number | null;          // 0-based, null when no player car in grid
  poolTotal: number;                  // betting pool at lock, for podium math
}
export interface RaceGame {
  update(dt: number): void;           // call from the host rAF loop; a NO-OP once disposed (a trailing
                                      // rAF frame after dispose() must never touch freed geometry / DOM)
  phase(): "LOADING" | "MARKET" | "COUNTDOWN" | "RACING" | "FINISH"; // after dispose(): the FROZEN last
                                      // phase at teardown (state is never reset), so hosts can still read it
  requestExit(): void;                // exits at the next safe phase boundary; a no-op once disposed
  dispose(): void;                    // full teardown: scene groups, HUD DOM, materials. Idempotent.
}

// facing convention copied from cruisers.ts / car.ts: MODEL_YAW + per-car yaw makes every GLB face
// -Z, and track.poseAt()'s rot aligns the anchor's -Z with the racing-line tangent.
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
// Substep budget per update(): high enough that a SINGLE huge dt (throttled/hidden tab) runs the
// whole race to completion instead of stalling — the loop also early-exits the instant every car has
// finished, so this cap is only ever the pathological-input guard (any real race finishes < ~9k).
const SUB_STEP_CAP = 60000;

const OUTCOME_NOISE = 2.8;  // additive seeded spread — big enough that a common can upset a legendary

/** seeded PRNG (moved from race-preview.ts; now exported so the harness + tests can reuse it). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The 8-car roster the prototype hard-coded (was `SPECS`), re-expressed as a GridEntrant[] so the
// harness has a self-contained grid. Fields are verbatim; strength maps through the shared table,
// surgeAmpBonus is 0 (no perks), isPlayer is false (spectate).
export const DEFAULT_GRID: GridEntrant[] = [
  { name: "Bedrock", rarity: 5, url: "/models/flintstone.glb", scale: 0.7, strength: STRENGTH[5], surgeAmpBonus: 0, isPlayer: false },
  { name: "DeLorean", rarity: 4, url: "/models/delorean.glb", strength: STRENGTH[4], surgeAmpBonus: 0, isPlayer: false },
  { name: "Cybertruck", rarity: 3, url: "/models/cybertruck.glb", scale: 1.3, strength: STRENGTH[3], surgeAmpBonus: 0, isPlayer: false },
  { name: "Vaporwave", rarity: 3, url: "/models/vaporwave.glb", strength: STRENGTH[3], surgeAmpBonus: 0, isPlayer: false },
  { name: "Prickle", rarity: 2, url: "/models/cactus.glb", yaw: Math.PI / 2, strength: STRENGTH[2], surgeAmpBonus: 0, isPlayer: false },
  { name: "Knockout", rarity: 3, url: "/models/knockout.glb", yaw: Math.PI / 2, strength: STRENGTH[3], surgeAmpBonus: 0, isPlayer: false },
  { name: "Big Frank", rarity: 1, url: "/models/wiener.glb", yaw: Math.PI / 2, strength: STRENGTH[1], surgeAmpBonus: 0, isPlayer: false },
  { name: "Trabant", rarity: 1, url: "/models/trabant.glb", yaw: Math.PI / 2, strength: STRENGTH[1], surgeAmpBonus: 0, isPlayer: false },
];

// ── per-car runtime state ───────────────────────────────────────────────────────────────────────
interface Surge { start: number; len: number; amp: number } // distance window over the full race
interface RaceCar {
  entrant: GridEntrant;
  color: string;
  anchor: THREE.Group;
  rig: WheelRig | null;
  model: THREE.Object3D | null; // loaded GLB (for disposal), null until the async load lands
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

/** Full-teardown disposer for a loaded car model — mirrors src/ui/reveal-car.ts disposeModel:
 *  reclaim the off-style toon variants, then walk the tree freeing geometry + materials. */
function disposeModel(o: THREE.Object3D): void {
  for (const mm of reclaimToonVariants(o)) mm.dispose();
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.isMesh) { m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose()); }
  });
}

export function createRaceGame(opts: RaceGameOptions): RaceGame {
  const { scene, camera, hudParent, grid } = opts;

  // ── mutable phase / sim state ──
  let phase: RacePhase = "LOADING";
  let seed = opts.seed;
  let maxRefSpeed = 90;
  let marketTimer = MARKET_TIME;
  let cdRemaining = CD_TIME;
  let goFlash = 0;
  let raceElapsed = 0;
  let finishTimer = 0;
  let simAccum = 0;
  let disposed = false;
  let exitRequested = false;
  let exited = false;
  let lastResult: RaceResult = { finishOrder: [], playerRank: null, poolTotal: 0 };

  // THREE resources this module owns and must free in dispose()
  const disposables: Array<{ dispose(): void }> = [];

  // ── world: track + environment go under one container group so add/remove is one call ──
  const raceGroup = new THREE.Group();
  const track = createRaceTrack();
  raceGroup.add(track.group);
  const environment = createRaceEnvironment(track);
  raceGroup.add(environment.group);
  const lapLen = track.length;
  const raceDist = TOTAL_LAPS * lapLen;

  const director = createRaceDirector(camera, track);
  const camControls = createCamControls(grid.length, hudParent);

  // ── shared sprites (per-instance so dispose() frees them cleanly): additive taillight glow + a
  // soft blob shadow to ground each car on the unlit road ──
  const tailTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,60,60,1)"); grd.addColorStop(0.4, "rgba(255,40,40,0.5)"); grd.addColorStop(1, "rgba(255,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  disposables.push(tailTex);
  const shadowTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(0,0,0,0.55)"); grd.addColorStop(0.6, "rgba(0,0,0,0.28)"); grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  disposables.push(shadowTex);
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  disposables.push(shadowGeo);

  const cars: RaceCar[] = grid.map((entrant, i) => {
    const anchor = new THREE.Group();
    raceGroup.add(anchor);
    // soft blob shadow flat on the ground under the car (unlit road won't show real shadows)
    const blobMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.9 });
    disposables.push(blobMat);
    const blob = new THREE.Mesh(shadowGeo, blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.06;
    blob.scale.set(9, 15, 1); // footprint-ish (x width, y = length along -Z)
    anchor.add(blob);
    // two taillight glows at the rear (car noses -Z, so rear is +Z after MODEL_YAW)
    for (const sx of [-1.6, 1.6]) {
      const spriteMat = new THREE.SpriteMaterial({ map: tailTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      disposables.push(spriteMat);
      const s = new THREE.Sprite(spriteMat);
      s.scale.set(2.4, 2.4, 1);
      s.position.set(sx, 1.1, 3.4);
      anchor.add(s);
    }
    return {
      entrant, color: tierOf(entrant.rarity).color, anchor, rig: null, model: null,
      laneOff: LANE_OFF[i], dOffset: (i % 2 === 0) ? 0 : GRID_STAGGER, base: 60, surges: [], T: BASE_T,
      dist: 0, speed: 0, finished: false, finishT: 0,
    };
  });

  const hud = createRaceHud(hudParent);
  const betPanel = createBetPanel(hudParent);
  const roster = cars.map((c, i) => ({ id: i, name: c.entrant.name, color: c.color }));
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
    // scoring strength now comes from the grid entrant (rarity + perk-adjusted upstream), not a
    // rarity lookup: hidden seeded score = strength + noise → sort desc for the finish order.
    const strengths = cars.map((c) => c.entrant.strength);
    const scored = cars.map((_c, i) => ({ i, score: strengths[i] + rng() * OUTCOME_NOISE }));
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((sc, rank) => {
      const c = cars[sc.i];
      c.T = BASE_T + rank * GAP + rng() * 0.4;
      // each surge's amplitude gains the entrant's perk bonus for that car (keeps the surge shape)
      c.surges = surgesForRank(rank, rng).map((s) => ({ ...s, amp: s.amp + c.entrant.surgeAmpBonus }));
      c.dist = 0; c.speed = 0; c.finished = false; c.finishT = 0;
    });
    for (const c of cars) c.base = calibrateBase(c);
    maxRefSpeed = Math.max(...cars.map((c) => c.base)) * 1.45; // reference top speed for the FOV kick
    return strengths;
  }

  // ── phase machine ─────────────────────────────────────────────────────────────────────────────
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
    // compute the exit payload BEFORE settling the market (podium credit wiring is a later task)
    const finishOrder = order();
    const playerIdx = grid.findIndex((g) => g.isPlayer);
    lastResult = {
      finishOrder,
      playerRank: playerIdx >= 0 ? finishOrder.indexOf(playerIdx) : null,
      poolTotal: betPanel.poolTotal(),
    };
    betPanel.settle(finishOrder[0]);
    fireExitIfReady();
  }

  function restart() {
    seed = (Math.random() * 1e9) | 0;
    enterMarket();
  }
  betPanel.onRaceAgain(restart);
  betPanel.onSkip(lockAndCountdown);

  const allFinished = () => cars.every((c) => c.finished);

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
      while (simAccum >= SUB_H && guard < SUB_STEP_CAP) {
        advance(SUB_H); simAccum -= SUB_H; guard++;
        if (allFinished()) break; // one giant dt must complete the race, not stall on the cap
      }
      if (allFinished()) enterFinish();
    } else if (phase === "FINISH") {
      if (!exited) { finishTimer -= dt; if (finishTimer <= 0) restart(); } // stay frozen once the player left
    }
  }

  // ── render-side ───────────────────────────────────────────────────────────────────────────────
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

  // ── camera: director for AUTO/CHASE/TV/DRONE; FREE is a host concern (OrbitControls stays in the
  // host — it needs the canvas element this module doesn't have), so the director idles in FREE ──
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
    if (sel === "mybet") { const mb = betPanel.myBet(); return mb >= 0 ? `My Bet · ${cars[mb].entrant.name}` : "My Bet"; }
    return cars[sel].entrant.name;
  }
  function runDirector(dt: number) {
    const mode = camControls.mode();
    camControls.setFocusLabel(focusLabel());
    if (mode === "FREE") return; // host owns the free-look camera; director idle
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
  function pushUi() {
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
      raceLeaderName: phase === "RACING" ? cars[ord[0]].entrant.name : null,
    });
  }

  // ── exit path ───────────────────────────────────────────────────────────────────────────────
  function fireExitIfReady() {
    if (exitRequested && !exited && phase === "FINISH") {
      exited = true;
      opts.onExit?.(lastResult);
    }
  }
  function requestExit() {
    if (disposed) return; // torn down — nothing to exit, and onExit must not fire against freed state
    exitRequested = true;
    fireExitIfReady(); // fire now if we're already at FINISH; otherwise enterFinish() will
  }

  // When the host wired an onExit, add a "Done" button to the FINISH results card (same DOM idiom as
  // the panel's RACE AGAIN button) so the player can leave. Harness passes no onExit → no Done button.
  if (opts.onExit) {
    const settleCard = betPanel.el.querySelector(".bp-settle");
    if (settleCard) {
      const done = document.createElement("button");
      done.type = "button";
      done.className = "bp-again";
      done.textContent = "Done";
      done.style.marginLeft = "10px";
      onTap(done, () => requestExit());
      settleCard.appendChild(done);
    }
  }

  // ── GLB loading (background; the placeholder anchors race regardless; no shader pre-warm because
  // the host owns the renderer) ─────────────────────────────────────────────────────────────────
  const loader = new GLTFLoader();
  function loadCar(car: RaceCar): void {
    loader.load(car.entrant.url, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = carNormScale(size, REF_LEN, car.entrant.scale ?? 1);
      model.scale.setScalar(scale);
      model.rotation.y = MODEL_YAW + (car.entrant.yaw ?? 0);
      const box2 = new THREE.Box3().setFromObject(model);
      const c = box2.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -box2.min.y, -c.z);
      if (disposed) { disposeModel(model); return; } // the game was torn down mid-load
      const savedRot = car.anchor.rotation.y;
      car.anchor.rotation.y = 0;
      car.anchor.add(model);
      car.anchor.updateMatrixWorld(true);
      car.rig = buildWheelRig(model, scale, { probe: false });
      car.anchor.rotation.y = savedRot;
      toonify(model, { outlineWidth: 0.3 }); // cel-shade + bold outline (reads at chase distance)
      car.model = model;
    }, undefined, (err) => { console.warn("[race-mode] GLB failed:", car.entrant.url, err); });
  }

  // ── dev hooks (harness only): state readout + a fixed-dt time-warp. No composer.render() here —
  // the host's rAF loop owns rendering; these advance the sim + the module-side per-frame update. ──
  if (opts.devHooks) {
    const w = window as unknown as { __raceState: () => unknown; __warp: (sec: number) => unknown };
    w.__raceState = () => ({
      phase,
      seed,
      lap: phase === "RACING" || phase === "FINISH" ? currentLap() : 0,
      order: order().map((i) => cars[i].entrant.name),
      speeds: cars.map((c) => +c.speed.toFixed(2)),
      wallet: +betPanel.wallet().toFixed(2),
      pool: +betPanel.poolTotal().toFixed(2),
      mode: camControls.mode(),
    });
    // fast-forward through the SAME per-frame path (fixed dt) so laps / order / finish / settlement
    // fire exactly as in real time. No-op during MARKET (can't skip betting); stops the instant it
    // reaches FINISH so the settlement state is observable.
    w.__warp = (sec: number) => {
      if (phase === "MARKET" || phase === "LOADING") return { skipped: phase };
      const steps = Math.max(1, Math.round(sec * 60));
      for (let i = 0; i < steps; i++) { step(1 / 60); if (phase === "FINISH") break; }
      placeCars(1 / 60);
      runDirector(1 / 60);
      track.update(1 / 60);
      environment.update(1 / 60);
      pushUi();
      return { phase, order: order().map((i) => cars[i].entrant.name), wallet: +betPanel.wallet().toFixed(2) };
    };
  }

  // ── boot: mount the race group; start GLB loads in the background (market opens on the first
  // update, so the anchors race whether or not the models have landed) ──
  scene.add(raceGroup);
  for (const c of cars) loadCar(c);

  return {
    update(dt: number) {
      if (disposed) return; // a trailing rAF frame after dispose() must not touch freed geometry / DOM
      if (phase === "LOADING") enterMarket(); // open the market on the first frame; models stream in
      step(dt);
      placeCars(dt);      // update world poses first so the director frames current positions
      runDirector(dt);
      track.update(dt);
      environment.update(dt);
      pushUi();
    },
    phase: () => phase, // frozen at teardown once disposed (see RaceGame doc); a bare read, always safe
    requestExit,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (opts.devHooks) {
        const w = window as unknown as Record<string, unknown>;
        delete w.__raceState;
        delete w.__warp;
      }
      scene.remove(raceGroup);
      hud.dispose();
      betPanel.dispose();
      camControls.dispose();
      track.dispose();
      environment.dispose();
      for (const c of cars) { if (c.model) { disposeModel(c.model); c.model = null; } }
      for (const d of disposables) d.dispose();
    },
  };
}
