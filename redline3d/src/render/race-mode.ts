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
import { localBookSource, mulberry32, type BookPhase, type RaceBookSource } from "./race-book-source";
import { createCamControls } from "../ui/cam-controls";
import { onTap } from "../ui/tap";
import { STRENGTH, type GridEntrant } from "../core/race-grid";
import { ownerPodiumPayout } from "../core/race-payout";
import { pNum, pColor } from "../config/visual-presets";
import { registerLightLab } from "../ui/light-lab";

// ── public surface ────────────────────────────────────────────────────────────────────────────
export interface RaceGameOptions {
  scene: THREE.Scene;                 // race group + environment are added/removed here
  camera: THREE.PerspectiveCamera;    // the director aims this
  hudParent: HTMLElement;             // race-hud / bet-panel / cam-controls mount here
  grid: GridEntrant[];                // from buildGrid(); player car may be grid[0]
  seed: number;                       // race outcome seed (mulberry32)
  // Quality tier (mirrors main.ts quality: true on the low/"reduced" tier). The in-app host passes the
  // REAL tier here; race-mode itself still doesn't branch on it (no render-cost gating exists yet), so
  // it's carried, not read — kept in the interface for when a low-tier render diet is actually built.
  lowTier: boolean;
  devHooks?: boolean;                 // install window.__raceState / __warp (harness only)
  // In-app hosts (main.ts) set this: the race then mounts its OWN light rig (hemi/key/rim), dusk fog,
  // and full IBL into the scene so it reads like the dev harness instead of the dark perps main-scene
  // lights — and registers the DEV "race-track" Light Lab folder. The harness leaves it off: it already
  // owns identical scene lights/fog/Light Lab (see race-preview.ts), so the race must not double them.
  provideSceneLighting?: boolean;
  // Host-owned renderer tone-mapping EXPOSURE accessor (main.ts). The renderer is not the race's to hold,
  // so the host applies/restores the ACES operator itself (beside its light mute); this thin get/set just
  // lets the "race-track" Light Lab expose an `exposure` knob that tunes the live value end-to-end in-game.
  exposure?: { get(): number; set(v: number): void };
  // Where the pools, the wallet and the WINNER come from. Absent → the browser-local sim that has
  // always shipped (`localBookSource()`), byte-for-byte: same seeded pools, same fake bettors, same
  // seeded finish draw. Present → an outside book (the on-chain paddock client) owns all of it and
  // this module is reduced to what it is good at, which is putting on the show. A host that passes
  // its own book also owns that book's lifetime; dispose() here only frees the one created inside.
  book?: RaceBookSource;
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

// ── reconciling the chain's 40s RACING window against this module's ~36s show ────────────────────
// The program gives a locked race a FIXED 40s window (RACE_SECS, state.rs) before the crank settles
// it. The show is shorter and not even a constant: last place finishes at BASE_T + 7·GAP + jitter,
// i.e. somewhere in 35.6–36.0s. Those two numbers will never line up, so one of them has to give.
//
// The chain's does not — it owns the RESULT and the MONEY, and stretching or squeezing the pacing to
// fill exactly 40s would mean re-tuning the one thing (`calibrateBase`) that guarantees the rendered
// order. So the show is ANCHORED TO THE END of the chain's window instead: the sim clock is driven
// from `secondsLeft()` such that the last car crosses the line with TAIL_HOLD seconds still on the
// chain's clock, and whatever is left over at the FRONT of the window is spent on the countdown.
// With the shipped constants that is 40 − 36 − 1 ≈ 3s of countdown, which is exactly CD_TIME — the
// numbers were chosen to fit (see the RACE_SECS comment in state.rs), so nothing is being squeezed.
//
// Three things fall out of anchoring to the END rather than the start, and they are the reason for
// the choice:
//  • Discovery lag is free. The browser learns about a lock up to a poll-interval late; that time
//    comes out of the countdown, never out of the race, so the chequered flag still lands where the
//    chain says it does.
//  • Joining mid-flight and a backgrounded tab are the SAME code path: the sim target is a pure
//    function of the chain's remaining seconds, so "start the race" and "resync to 27s into it" are
//    one line, not two features.
//  • The render can never overrun the settle. It cannot finish LATE, only early-and-hold.
const TAIL_HOLD = 1.0;      // seconds of chequered-flag hold left inside the chain's RACING window

/** seeded PRNG — now lives in race-book-source.ts (the local book draws its finish order off the same
 *  stream, and bet-panel.ts used to keep a second copy of it). Re-exported here because the harness,
 *  main.ts and the tests import it from this module. */
export { mulberry32 };

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

/** Full-teardown disposer for a loaded car model — mirrors src/render/car.ts disposeObject:
 *  collect geometries, materials AND their textures (from the active mesh materials plus the
 *  reclaimed off-style toon variant) into dedup Sets, then free all three. Freeing the textures is
 *  what stops the ~per-model GPU-texture leak across repeated race enter/dispose cycles.
 *  EXCEPTION: `gradientMap` is skipped — the toon cel ramps (_ramp / _worldRamp in toon.ts) are
 *  shared module singletons reused across the whole game and must survive a single race teardown. */
function disposeModel(o: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const collectMaterial = (material: THREE.Material | null | undefined) => {
    if (!material) return;
    materials.add(material);
    for (const [key, value] of Object.entries(material)) {
      if (key === "gradientMap") continue; // shared toon ramp singleton — never dispose it here
      if ((value as THREE.Texture | undefined)?.isTexture) textures.add(value as THREE.Texture);
    }
  };
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry) geometries.add(m.geometry);
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => collectMaterial(mm));
  });
  // toonify stashed each mesh's original material as the inactive variant; mesh.material only exposes
  // the active one, so also reclaim the inactive variant (the Set dedups any shared map → frees once).
  for (const mm of reclaimToonVariants(o)) collectMaterial(mm);
  for (const t of textures) t.dispose();
  for (const mm of materials) mm.dispose();
  for (const g of geometries) g.dispose();
}

// ── in-app race lighting (provideSceneLighting) ────────────────────────────────────────────────
// The DEV Light Lab has no unregister, and other scenes register once for a lifetime object. The race
// is created/disposed per entry, so instead of re-registering we register the "race-track" folder ONCE
// and bind its controls to whichever race is currently mounted through this module-level handle. Each
// fresh race sets `activeLighting`; dispose clears it (setters then no-op, getters fall back to the
// shipped preset). The folder edits the SAME "race-track" keys the harness honors → ★ SAVE ALL retunes
// both from one source (visual-presets.json).
interface RaceLighting { hemi: THREE.HemisphereLight; key: THREE.DirectionalLight; rim: THREE.DirectionalLight; scene: THREE.Scene; exposure: { get(): number; set(v: number): void } | null }
let activeLighting: RaceLighting | null = null;
let raceLabRegistered = false;
function ensureRaceTrackLab(): void {
  if (raceLabRegistered) return; // DEV-gated + idempotent (registerLightLab is a no-op in prod)
  raceLabRegistered = true;
  const fog = (): THREE.Fog | null => (activeLighting?.scene.fog instanceof THREE.Fog ? activeLighting.scene.fog : null);
  registerLightLab("race-track", { controls: [
    // exposure tunes the host renderer's ACES toneMappingExposure (main.ts applies/restores the operator);
    // this knob only bites while a race is mounted, else it reads the shipped preset
    { key: "exposure", label: "exposure", kind: "num", min: 0, max: 3, step: 0.01, get: () => activeLighting?.exposure?.get() ?? pNum("race-track", "exposure", 1.05), set: (v) => { activeLighting?.exposure?.set(v); } },
    { key: "hemi", label: "hemisphere", kind: "num", min: 0, max: 3, step: 0.01, get: () => activeLighting?.hemi.intensity ?? pNum("race-track", "hemi", 0.9), set: (v) => { if (activeLighting) activeLighting.hemi.intensity = v; } },
    { key: "key", label: "key (directional)", kind: "num", min: 0, max: 3, step: 0.01, get: () => activeLighting?.key.intensity ?? pNum("race-track", "key", 1.15), set: (v) => { if (activeLighting) activeLighting.key.intensity = v; } },
    { key: "keyColor", label: "key color", kind: "color", get: () => activeLighting ? "#" + activeLighting.key.color.getHexString() : pColor("race-track", "keyColor", "#ffffff"), set: (v) => { activeLighting?.key.color.set(v); } },
    { key: "rim", label: "rim", kind: "num", min: 0, max: 3, step: 0.01, get: () => activeLighting?.rim.intensity ?? pNum("race-track", "rim", 0.55), set: (v) => { if (activeLighting) activeLighting.rim.intensity = v; } },
    { key: "fogColor", label: "fog color", kind: "color", get: () => { const f = fog(); return f ? "#" + f.color.getHexString() : pColor("race-track", "fogColor", "#3a2246"); }, set: (v) => { fog()?.color.set(v); } },
    { key: "fogNear", label: "fog near", kind: "num", min: 0, max: 1500, step: 1, get: () => fog()?.near ?? pNum("race-track", "fogNear", 260), set: (v) => { const f = fog(); if (f) f.near = v; } },
    { key: "fogFar", label: "fog far", kind: "num", min: 0, max: 4000, step: 1, get: () => fog()?.far ?? pNum("race-track", "fogFar", 1300), set: (v) => { const f = fog(); if (f) f.far = v; } },
  ] });
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
  // set when provideSceneLighting swaps the global scene fog/background/env-intensity → restored in dispose()
  let restoreSceneEnv: (() => void) | null = null;
  let ownLighting: RaceLighting | null = null; // this race's Light Lab binding (identity-checked on dispose)
  let lastResult: RaceResult = { finishOrder: [], playerRank: null, poolTotal: 0 };
  // ── chain-driven state (all inert while the book has no phase of its own) ──
  // Latches the first time the book reports a phase, and never unlatches: from then on the CHAIN owns
  // every transition and the local MARKET_TIME/FINISH_HOLD timers are dead code for this instance.
  // Latching (rather than re-testing each frame) is what stops a single dropped ER read from handing
  // the phase machine back to a local clock mid-race.
  let chainDriven = false;
  // The finish order `setupRace` last paced the field to. The invariant this exists to enforce: while
  // the book reports an order, the pacing was solved from THAT order. Checked every step; a violation
  // re-solves before any car moves.
  let pacedOrder: number[] = [];
  let raceLen = BASE_T;       // last car's target finish time — the length of the show, exactly
  // A market we have rendered has not been locked into a race yet. Without it, two consecutive races
  // that happen to draw the identical finish order would be indistinguishable from one race still
  // running, and the second one would never be set up.
  let awaitingLock = false;

  // ── the book: pools, wallet, stakes and the RESULT. Host-supplied or the local sim (see opts.book).
  // `ownBook` is non-null only when we built it, and only that one gets disposed with the race.
  const ownBook = opts.book ? null : localBookSource();
  const book: RaceBookSource = opts.book ?? ownBook!;

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

  // Pace the field to a finish order that is ALREADY DECIDED (the book decided it — locally from a
  // seeded strength draw, on-chain from `Race.order`). `calibrateBase` then back-solves each car's
  // constant base speed so it crosses the line at exactly T_i, which is why an outside result costs
  // this module nothing: the order was always an input here, only its author changed. `rng` is the
  // race's stream, already advanced past the book's draw, so the T/surge jitter is unchanged.
  function setupRace(rng: () => number, order: number[]): void {
    order.forEach((carIdx, rank) => {
      const c = cars[carIdx];
      c.T = BASE_T + rank * GAP + rng() * 0.4;
      // each surge's amplitude gains the entrant's perk bonus for that car (keeps the surge shape)
      c.surges = surgesForRank(rank, rng).map((s) => ({ ...s, amp: s.amp + c.entrant.surgeAmpBonus }));
      c.dist = 0; c.speed = 0; c.finished = false; c.finishT = 0;
    });
    for (const c of cars) c.base = calibrateBase(c);
    maxRefSpeed = Math.max(...cars.map((c) => c.base)) * 1.45; // reference top speed for the FOV kick
    // The field was just put back on the grid, so the clock it is measured against goes back to zero
    // with it. (enterMarket zeroed these right after this call anyway; a mid-race RE-solve — a chain
    // order arriving late, or a resync after a backgrounded tab — has no such follow-up and needs it.)
    raceElapsed = 0; simAccum = 0;
    pacedOrder = order.slice();
    raceLen = Math.max(...cars.map((c) => c.T)); // the show's own length, jitter included
  }

  /** Same finish order, element for element. Cheap enough to run every frame, which is the point:
   *  it is the tripwire that catches the book's order changing under a race already being paced. */
  function sameOrder(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // ── phase machine ─────────────────────────────────────────────────────────────────────────────
  function enterMarket() {
    // ONE seeded stream drives the whole race. The book draws the finish order off it FIRST (one draw
    // per car — exactly where the old inline `strengths[i] + rng() * OUTCOME_NOISE` scoring sat), then
    // setupRace consumes the T-jitter and surge-jitter draws that follow. Handing the book this stream
    // instead of letting it seed a private one is what keeps every later draw on the same sequence
    // position it always had: the same seed still produces the same race, down to the surge shapes.
    const rng = mulberry32(seed);
    const strengths = cars.map((c) => c.entrant.strength);
    book.openMarket({ seed, strengths, rng });
    // A book with no order yet (a chain market that has not locked) gets the grid order as a stand-in
    // so nothing paces off undefined; racing against a not-yet-decided result is Task 5's job.
    setupRace(rng, book.finishOrder() ?? cars.map((_c, i) => i));
    phase = "MARKET";
    marketTimer = MARKET_TIME;
    director.reset();
  }

  /** Close the market and roll the lights. `order` is the RESULT, when the book has one to give: a
   *  chain market does not reveal `Race.order` until the crank locks it, so the pacing `enterMarket`
   *  solved is a placeholder (the grid order) and has to be re-solved from the real thing HERE —
   *  before the countdown, before any car has moved a metre. Getting this wrong is the one bug this
   *  whole path is built to make impossible: the field would run to a stale order and the chequered
   *  flag would fall on a car the chain did not pay.
   *
   *  A book that already had its order at `openMarket` (the local sim) passes the same array it
   *  passed then, `sameOrder` sees no change, and nothing is re-solved — so the browser-only race is
   *  byte-for-byte what it always was, down to the seeded jitter.
   *
   *  The re-solve draws off a FRESH `mulberry32(seed)` rather than the market's stream, because the
   *  market's stream is long gone by the time a chain reveals its order. Consequence, stated rather
   *  than discovered later: under a chain book `seed` never changes (nothing calls `restart()`), so
   *  the jitter attached to each RANK repeats race after race. What varies is which car holds which
   *  rank — the chain redraws that every time — which is the variation an audience actually sees. */
  function lockAndCountdown(order?: number[]) {
    if (order && !sameOrder(order, pacedOrder)) setupRace(mulberry32(seed), order);
    book.lock();
    phase = "COUNTDOWN";
    cdRemaining = CD_TIME;
    goFlash = 0;
  }

  function enterFinish() {
    phase = "FINISH";
    finishTimer = FINISH_HOLD;
    // compute the exit payload BEFORE settling the market (podium credit wiring is a later task)
    const simOrder = order();
    // When a chain decided the result, the CHAIN's order is the result — the sim was paced to
    // reproduce it, not to produce it. They agree because `calibrateBase` solves each car's speed for
    // an exact finish time, but "they agree" is a claim about numerical integration, and this is the
    // one place where being wrong pays the wrong car. So the authoritative array is used and the
    // sim's is compared to it, loudly.
    const bookOrder = chainDriven ? book.finishOrder() : null;
    if (bookOrder && !sameOrder(bookOrder, simOrder)) {
      console.error("[race-mode] rendered order != chain order — rendering the chain's", { simOrder, bookOrder });
    }
    const finishOrder = bookOrder ?? simOrder;
    const playerIdx = grid.findIndex((g) => g.isPlayer);
    lastResult = {
      finishOrder,
      playerRank: playerIdx >= 0 ? finishOrder.indexOf(playerIdx) : null,
      poolTotal: book.total(),
    };
    book.settle(finishOrder[0]);
    // Owner podium credit: the player SEES their payout on the FINISH card. Must come AFTER settle so
    // the credit line never paints without a settled result behind it (ownerPodiumPayout returns 0
    // beyond rank 2, so no extra rank check is needed — off-podium finishes credit nothing).
    if (lastResult.playerRank !== null) {
      const pay = ownerPodiumPayout(lastResult.poolTotal, lastResult.playerRank);
      if (pay > 0) book.credit(pay, `Podium — P${lastResult.playerRank + 1}`);
    }
    fireExitIfReady();
  }

  function restart() {
    seed = (Math.random() * 1e9) | 0;
    enterMarket();
  }
  // Both of these are the local sim's privileges: you cannot skip a market the chain is holding open,
  // and you cannot re-run a race the chain already settled. They go quiet rather than desyncing the
  // show from the book — the chain opens the next market on its own, seconds later.
  betPanel.onRaceAgain(() => { if (!chainDriven) restart(); });
  betPanel.onSkip(() => { if (!chainDriven) lockAndCountdown(); });
  // The panel emits intent; the book decides whether the bet lands. Nothing on screen moves until the
  // next pushUi() reads the book back — which is exactly what makes an ER round-trip renderable.
  betPanel.onBet((carId, amount) => book.placeBet(carId, amount));

  /** Roster index of the car the player has the most money on, or -1. Drives the camera's MY BET
   *  focus and the director's battle cuts — the panel used to answer this from its own stakes; the
   *  book owns them now. */
  function myBet(): number {
    const stakes = book.myStakes();
    let bi = -1, bv = 0;
    stakes.forEach((s, i) => { if (s > bv) { bv = s; bi = i; } });
    return bi;
  }

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

  /** Run the pacing sim forward by `seconds` of race time, in fixed sub-steps. Extracted so the local
   *  clock and the chain clock feed the SAME integrator — the only difference between them is where
   *  `seconds` comes from. */
  function runSim(seconds: number) {
    simAccum += seconds;
    let guard = 0;
    while (simAccum >= SUB_H && guard < SUB_STEP_CAP) {
      advance(SUB_H); simAccum -= SUB_H; guard++;
      if (allFinished()) break; // one giant dt must complete the race, not stall on the cap
    }
  }

  function step(dt: number) {
    // Every phase, not just MARKET: a chain book has to see the race lock and settle without this
    // module telling it when to look. The local book no-ops the moment its odds freeze, so polling it
    // outside MARKET costs nothing and changes nothing.
    book.poll(dt);
    const bp = book.phase();
    if (bp !== null) chainDriven = true;
    if (chainDriven) { stepChain(dt, bp); return; }
    if (phase === "MARKET") {
      marketTimer -= dt;
      if (marketTimer <= 0) lockAndCountdown();
    } else if (phase === "COUNTDOWN") {
      cdRemaining -= dt;
      if (cdRemaining <= 0) { phase = "RACING"; goFlash = GO_HOLD; }
    } else if (phase === "RACING") {
      if (goFlash > 0) goFlash -= dt;
      runSim(dt);
      if (allFinished()) enterFinish();
    } else if (phase === "FINISH") {
      if (!exited) { finishTimer -= dt; if (finishTimer <= 0) restart(); } // stay frozen once the player left
    }
  }

  /** The phase machine when a BOOK owns the phases — i.e. when the market, the lock and the
   *  settlement are all facts on a chain and this module's job is to be at the right point of the
   *  show when each of them happens.
   *
   *  Nothing here counts down a local timer. Every transition is read off the book, and the sim's
   *  position inside the race is a pure function of the book's remaining seconds (see TAIL_HOLD), so
   *  a stalled tab, a slow RPC or a race joined halfway through all converge to the same state as a
   *  client that watched the whole thing. */
  function stepChain(dt: number, bp: BookPhase | null) {
    // No snapshot to act on: a book that has lost its read reports null, and the show HOLDS. Running
    // on a local clock past a chain we cannot currently see is how the render ends up contradicting
    // the payout — the crank is ~1s away, so holding costs a beat and risks nothing.
    if (bp === null) return;

    if (bp === "MARKET") {
      // A market is open on-chain. Anything other than MARKET on screen means this is a race we have
      // not opened yet — the first one, or the next one after a settle we are still showing.
      if (phase !== "MARKET") enterMarket();
      marketTimer = book.secondsLeft() ?? MARKET_TIME; // the chain's clock; it cannot drift from ours
      awaitingLock = true;
      return;
    }

    // RACING or FINISH: the market is shut, so `Race.order` exists and the winner is already decided.
    const ord = book.finishOrder();
    if (ord && (awaitingLock || !sameOrder(ord, pacedOrder))) {
      // Re-solve the pacing onto the real order. Arriving here from anything but MARKET means this
      // race's market never reached the screen — a mid-flight join, or a `seq` that jumped several
      // races while the tab was backgrounded — so the race context (pools, roster, camera) is rebuilt
      // for the race we are about to run rather than continuing the stale one.
      if (phase !== "MARKET") enterMarket();
      lockAndCountdown(ord);
      awaitingLock = false;
    }

    if (bp === "RACING") {
      // Where the show has to be, measured from the END of the chain's window (see TAIL_HOLD).
      // Negative → the race has not started yet and the remainder is the countdown.
      const target = raceLen - ((book.secondsLeft() ?? 0) - TAIL_HOLD);
      if (target < 0) {
        if (phase !== "FINISH") { phase = "COUNTDOWN"; cdRemaining = Math.min(CD_TIME, -target); }
        return;
      }
      if (phase === "COUNTDOWN") { phase = "RACING"; goFlash = GO_HOLD; }
      if (phase !== "RACING") return; // already at FINISH: the show ran out ahead of the chain, as designed
      if (goFlash > 0) goFlash -= dt;
      // Never backwards — `target` only grows within a race, and a fresh race resets raceElapsed with
      // the re-solve above, so this is a guard against a snapshot arriving out of order, not a clamp.
      if (target > raceElapsed) runSim(target - raceElapsed);
      if (allFinished()) enterFinish();
      return;
    }

    // bp === "FINISH": the chain has settled. The render must not still be mid-race — force the
    // remaining laps through the same integrator (one giant step, exactly as a throttled tab does)
    // so the flag falls before the result card, never after it.
    if (phase !== "FINISH") {
      runSim(raceLen - raceElapsed + 1);
      enterFinish();
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
    if (sel === "mybet") { const mb = myBet(); return mb >= 0 ? mb : ord[0]; }
    return sel;
  }
  function focusLabel(): string {
    const sel = camControls.focusSel();
    if (sel === "leader") return "Leader";
    if (sel === "mybet") { const mb = myBet(); return mb >= 0 ? `My Bet · ${cars[mb].entrant.name}` : "My Bet"; }
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
      mode: mode as DirectorMode, focus: resolveFocus(), myBet: myBet(),
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
    // The panel holds no money of its own — every figure below is read off the book each frame, so a
    // pool that moved in the ER between two frames shows up here without anything having to be told.
    betPanel.render({
      phase,
      marketRemaining: marketTimer,
      raceLeaderName: phase === "RACING" ? cars[ord[0]].entrant.name : null,
      pools: book.pools(),
      total: book.total(),
      mults: book.multipliers(),
      stakes: book.myStakes(),
      wallet: book.wallet(),
      pendingCar: book.pendingBet(),
      settle: book.lastSettle(),
      credit: book.creditNote(),
      // Optional on the interface, so a book without them (the local sim has no account to open and
      // nothing to claim later) simply reports nothing and the panel paints nothing.
      onboarding: book.onboarding?.() ?? null,
      claim: book.claimWindow?.() ?? null,
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
      wallet: +book.wallet().toFixed(2),
      pool: +book.total().toFixed(2),
      mode: camControls.mode(),
      // ── the book's side of the same instant, so a browser check can compare the show against the
      // chain WITHOUT reaching into the ER a second time and racing the poll it is trying to verify.
      chainDriven,
      bookPhase: book.phase(),
      bookSecondsLeft: book.secondsLeft(),
      // entrants[slot] = roster index, i.e. the crank's grid permutation, named
      entrants: book.entrants().map((i) => cars[i]?.entrant.name ?? `?${i}`),
      // winner-first CAR names straight off the book — this is the array the render must match
      bookOrder: book.finishOrder()?.map((i) => cars[i]?.entrant.name ?? `?${i}`) ?? null,
      pacedOrder: pacedOrder.map((i) => cars[i]?.entrant.name ?? `?${i}`),
      pools: book.pools().map((p) => +p.toFixed(2)),
      mults: book.multipliers().map((m) => +m.toFixed(3)),
      stakes: book.myStakes().map((s) => +s.toFixed(2)),
      raceElapsed: +raceElapsed.toFixed(2),
      raceLen: +raceLen.toFixed(2),
      settle: book.lastSettle(),
    });
    // fast-forward through the SAME per-frame path (fixed dt) so laps / order / finish / settlement
    // fire exactly as in real time. No-op during MARKET (can't skip betting); stops the instant it
    // reaches FINISH so the settlement state is observable. Also a no-op under a chain book: the sim
    // clock is derived from the chain's remaining seconds there, so "warping" would advance the show
    // and then be pulled straight back to wherever the chain actually is.
    w.__warp = (sec: number) => {
      if (chainDriven) return { skipped: "chain" };
      if (phase === "MARKET" || phase === "LOADING") return { skipped: phase };
      const steps = Math.max(1, Math.round(sec * 60));
      for (let i = 0; i < steps; i++) { step(1 / 60); if (phase === "FINISH") break; }
      placeCars(1 / 60);
      runDirector(1 / 60);
      track.update(1 / 60);
      environment.update(1 / 60);
      pushUi();
      return { phase, order: order().map((i) => cars[i].entrant.name), wallet: +book.wallet().toFixed(2) };
    };
  }

  // ── in-app lighting rig (provideSceneLighting) — installed LAST so a construction throw above bails
  // before any global scene state is touched. Own hemi/key/rim mounted on the race group (so they
  // mount/dispose with the race); values + fog read from the SAME "race-track" presets the harness
  // honors, so the in-app race and the dev harness share one tuning source. Scene fog/background/
  // env-intensity are GLOBAL → saved here, restored in dispose(). ──
  if (opts.provideSceneLighting) {
    const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x120a24, pNum("race-track", "hemi", 0.9));
    const key = new THREE.DirectionalLight(pColor("race-track", "keyColor", "#ffffff"), pNum("race-track", "key", 1.15)); // key for shape
    key.position.set(80, 150, 60);
    const rim = new THREE.DirectionalLight(0x6ab8ff, pNum("race-track", "rim", 0.55)); // cool rim from the skyline side
    rim.position.set(-120, 60, -120);
    raceGroup.add(hemi, key, rim);
    // dusk atmosphere (matches race-preview.ts applyStyleFog toon branch): far fog pushed out to 1300 so
    // the circuit + near skyline read, and full IBL (the perps scene dims env to 0.55 → washes the cars out)
    const prevFog = scene.fog, prevBg = scene.background, prevEnvI = scene.environmentIntensity;
    scene.fog = new THREE.Fog(pColor("race-track", "fogColor", "#3a2246"), pNum("race-track", "fogNear", 260), pNum("race-track", "fogFar", 1300));
    scene.background = new THREE.Color(0x140a24);
    scene.environmentIntensity = 1;
    // Lift the host camera's far plane to harness parity (race-preview.ts uses 4000). The toon sky dome
    // (race-environment.ts, radius ≈ R+1400 = 1791 about the track center) dips below the horizon and its
    // warm-orange bowl is what backs the semi-transparent near-black floor into a warm dusk. From the orbit
    // camera positions that bowl sits up to ~camera-distance+1791 away, so the app camera's default far of
    // 2000 (scene.ts) far-clips it — the dark scene.background then shows through and the floor renders black.
    // 4000 keeps the bowl inside the frustum. GLOBAL camera state → saved here, restored in restoreSceneEnv().
    const prevFar = camera.far;
    camera.far = 4000;
    camera.updateProjectionMatrix();
    restoreSceneEnv = () => {
      scene.fog = prevFog; scene.background = prevBg; scene.environmentIntensity = prevEnvI;
      camera.far = prevFar; camera.updateProjectionMatrix();
    };
    ownLighting = { hemi, key, rim, scene, exposure: opts.exposure ?? null };
    activeLighting = ownLighting;
    ensureRaceTrackLab(); // DEV: bind the "race-track" Light Lab folder to this race (no-op in prod)
  }

  // ── boot: mount the race group; start GLB loads in the background (market opens on the first
  // update, so the anchors race whether or not the models have landed) ──
  scene.add(raceGroup);
  for (const c of cars) loadCar(c);

  return {
    update(dt: number) {
      if (disposed) return; // a trailing rAF frame after dispose() must not touch freed geometry / DOM
      // Open the market on the first frame; models stream in. UNLESS the book already has a phase of
      // its own — then it decides when a market opens, and flashing a local one over a chain that is
      // mid-race would show a market nobody can bet into. `phase()` is a pure read on both books.
      if (phase === "LOADING" && book.phase() === null) enterMarket();
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
      // restore the perps scene's global fog/background/env-intensity + release the Light Lab binding
      // (its controls fall back to the shipped presets until the next race mounts). Identity-checked so a
      // teardown can never blank a DIFFERENT race's binding if the single-race guarantee ever weakens.
      if (restoreSceneEnv) { restoreSceneEnv(); restoreSceneEnv = null; }
      if (ownLighting && activeLighting === ownLighting) activeLighting = null;
      scene.remove(raceGroup);
      ownBook?.dispose?.(); // only the book WE built — a host-supplied one outlives this race
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
