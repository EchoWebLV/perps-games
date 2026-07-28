// Spectator-race preview (DEV-ONLY, not part of the game — modelled on src/lobby-preview.ts).
// The race sim itself now lives in src/render/race-mode.ts (createRaceGame), shared with the in-app
// grand-prix mode. This file is the thin HOST harness: it owns the WebGLRenderer, the bloom/edge
// composer, the camera, the scene lights + fog + PMREM environment, OrbitControls, the DEV Light Lab,
// window resize, and a resilient rAF ticker. Each frame it calls game.update(dt) then composer.render().
// race-preview.html is not a vite build input, so this stays a dev harness; nothing here is wired
// into the game.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { installOutlineDevControls, isToonEnabled, onToonChanged, refreshToonStyle, getOutlineWidth, setOutlineWidth, getWorldRampBand, setWorldRampBand } from "./render/toon";
import { EdgeOutlinePass, edgePassEnabled, setEdgePassEnabled } from "./render/edge-outline-pass";
import { registerLightLab } from "./ui/light-lab";
import { pNum, pColor } from "./config/visual-presets";
import { createRaceGame, DEFAULT_GRID, type RaceGame } from "./render/race-mode";
import { createChainBookSource, type RaceBookSource } from "./render/race-book-source";
import { createPaddockBook } from "./chain/paddock";
import { createPaddockStaging } from "./chain/paddock-staging";
import { createDevKeypairPort } from "./chain/dev-keypair-port";
import { portToAnchorWallet } from "./chain/anchor-wallet";
import { CHAIN } from "./chain/config";

// ── chain mode (?chain=1) ─────────────────────────────────────────────────────────────────────
// Off by default: the harness is a rendering bench first, and it has to keep working with no RPC.
// With the flag it points at the REAL devnet paddock book — the same singleton Race the scheduled
// crank has been cycling unattended — so the market, the clock and the winner on screen are the
// chain's. race-preview.html is not a vite build input (vite.config.ts:73-78), so none of this ships.
//
// The wallet is the persisted dev keypair (localStorage, or VITE_DEV_SECRET). Reading the book needs
// no SOL at all: an AnchorProvider just needs SOME pubkey to build against.
//
// ?bet=1 adds the WRITE path on top, and is OFF by default because it is the half that costs money.
// It wires `ChainBookOptions.staging` to a real `createPaddockStaging`, which builds the seat AHEAD
// of any tap (join → wrap → deposit → delegate_bettor on L1) and silently refills it when it runs
// short, so the BET button is a single ER send. Without it the book stays exactly the read-only bench
// it has always been — the right default, because offering a bet to an unfunded keypair is offering
// a bet that cannot land.
const params = new URLSearchParams(location.search);
const chainMode = params.get("chain") === "1";
const betMode = chainMode && params.get("bet") === "1";

/** The STAKE the harness stages against on entry, in base units. It is `ensure()`'s argument, not a
 *  deposit size: the controller targets `STAKE_BUFFER_BETS` (5) × this, capped by what the wallet can
 *  actually reach, so the seat holds several bets' worth and the heavy refill round trip stays rare.
 *
 *  1.6e7 lamports = 0.016 SOL, which stages toward the same effective 0.08 SOL the harness has always
 *  deposited. The old 0.08 default meant 0.4 SOL — very nearly the whole dev wallet — and this harness
 *  has no cash-out control to get it back out. `?deposit=<SOL>` overrides it for a richer run. */
const DEV_DEPOSIT_LAMPORTS = (() => {
  const sol = Number(params.get("deposit"));
  return Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : 16_000_000n;
})();

const vw = () => innerWidth || 1280;
const vh = () => innerHeight || 800;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(vw(), vh());
renderer.toneMapping = THREE.ACESFilmicToneMapping; // cinematic response — the big "flat neon" fix
renderer.toneMappingExposure = pNum("race-track", "exposure", 1.05); // moody-noir: darkness is the canvas, neon is the paint
renderer.domElement.style.display = "block";
renderer.domElement.style.width = "100vw";
renderer.domElement.style.height = "100vh";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Atmosphere follows the art style, swapped live by the toggle. TOON = warm dusk haze (city recedes
// into it while the sun + parallax mountains own the horizon, far pushed out). CLASSIC = the pre-toon
// dark-violet night void.
const applyStyleFog = (on: boolean): void => {
  if (on) { scene.background = new THREE.Color(0x140a24); scene.fog = new THREE.Fog(pColor("race-track", "fogColor", "#3a2246"), pNum("race-track", "fogNear", 260), pNum("race-track", "fogFar", 1300)); }
  else { scene.background = new THREE.Color(0x05030f); scene.fog = new THREE.Fog(0x0a0518, 210, 760); }
};
applyStyleFog(isToonEnabled());
onToonChanged(applyStyleFog);
// near/far tightened for depth-buffer precision (the road decals stack in <1u of vertical range):
// near 2 (camera never gets closer — clearance keeps it ≥8 from cars), far just past the sky dome.
const camera = new THREE.PerspectiveCamera(55, vw() / vh(), 2, 4000);
camera.position.set(0, 130, 210);
camera.lookAt(0, 0, 0);

// lighting (added to OUR scene only) so the metallic cars read richly against the dark circuit
// PMREM environment map (same pattern as the game's garage-room.ts) → real reflections on car paint
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x120a24, pNum("race-track", "hemi", 0.9));
scene.add(hemi);
const key = new THREE.DirectionalLight(pColor("race-track", "keyColor", "#ffffff"), pNum("race-track", "key", 1.15)); // key for shape
key.position.set(80, 150, 60);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6ab8ff, pNum("race-track", "rim", 0.55));  // cool rim from the skyline side
rim.position.set(-120, 60, -120);
scene.add(rim);

// ── bloom post-processing (the defining look for the neon aesthetic) ─────────────────────────
const composer = new EffectComposer(renderer);
composer.renderTarget1.samples = 4;
composer.renderTarget2.samples = 4;
composer.addPass(new RenderPass(scene, camera));
// strength / radius / threshold tuned so neon edges glow but the env-lit cars don't blow out
const bloom = new UnrealBloomPass(new THREE.Vector2(vw(), vh()), pNum("race-track", "bloomStrength", 0.62), pNum("race-track", "bloomRadius", 0.4), pNum("race-track", "bloomThreshold", 0.62));
composer.addPass(bloom);
// toon depth-edge pass (after bloom). Gated to toon style + the `toon.edgePass` kill-switch. Disabled
// → composer routes bloom straight to screen. (The prototype excluded the car anchors here; the cars
// now live inside createRaceGame and carry their own hull outlines, so no exclude list is wired.)
const edgePass = new EdgeOutlinePass(scene, camera);
edgePass.setSize(vw(), vh());
edgePass.enabled = false;
composer.addPass(edgePass);
// OutputPass LAST — tone mapping (ACES here) + linear→sRGB, restoring the conversion the bloom pass
// did via its MeshBasic screen-blit when it was last (else the edge pass ships a linear frame → dark).
composer.addPass(new OutputPass());
const applyEdge = (): void => { edgePass.enabled = isToonEnabled() && edgePassEnabled(); };
applyEdge();
onToonChanged(applyEdge);

// ── manual camera: OrbitControls kept host-side (it needs the canvas element). The camera mode strip
// lives inside createRaceGame; FREE-mode ↔ orbit coordination did not survive the extraction (it
// spanned the module boundary), so orbit stays instantiated but inert, ready to re-wire in a later task.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 25;
orbit.maxDistance = 900;
orbit.maxPolarAngle = Math.PI * 0.49; // can't dip under the floor
orbit.enabled = false;
orbit.target.set(0, 2, 0);

// ── DEV Light Lab (key L / ?lightlab=1). Global = shared toon engine knobs; per-context bloom/
// exposure/fog live in the race-track folder so they never clobber the main game's presets. ──
registerLightLab("Global", { controls: [
  { key: "outlineScale", label: "outline scale", kind: "num", min: 0, max: 3, step: 0.05, get: () => getOutlineWidth(), set: (v) => setOutlineWidth(v) },
  { key: "rampFloor", label: "toon ramp floor", kind: "color", get: () => getWorldRampBand(0), set: (v) => setWorldRampBand(0, v) },
  { key: "rampBand2", label: "toon ramp band 2", kind: "color", get: () => getWorldRampBand(1), set: (v) => setWorldRampBand(1, v) },
  { key: "edgePass", label: "edge pass", kind: "bool", get: () => edgePass.enabled, set: (v) => { setEdgePassEnabled(v); edgePass.enabled = v && isToonEnabled(); } },
  { key: "edgeDepth", label: "edge depth thresh", kind: "num", min: 0.01, max: 2, step: 0.01, get: () => edgePass.depthThreshold, set: (v) => { edgePass.depthThreshold = v; } },
  { key: "edgeNormal", label: "edge normal thresh", kind: "num", min: 0.01, max: 2, step: 0.01, get: () => edgePass.normalThreshold, set: (v) => { edgePass.normalThreshold = v; } },
  { key: "edgeThickness", label: "edge thickness px", kind: "num", min: 0.5, max: 4, step: 0.05, get: () => edgePass.thickness, set: (v) => { edgePass.thickness = v; } },
] });
registerLightLab("race-track", { controls: [
  { key: "exposure", label: "exposure", kind: "num", min: 0, max: 3, step: 0.01, get: () => renderer.toneMappingExposure, set: (v) => { renderer.toneMappingExposure = v; } },
  { key: "hemi", label: "hemisphere", kind: "num", min: 0, max: 3, step: 0.01, get: () => hemi.intensity, set: (v) => { hemi.intensity = v; } },
  { key: "key", label: "key (directional)", kind: "num", min: 0, max: 3, step: 0.01, get: () => key.intensity, set: (v) => { key.intensity = v; } },
  { key: "keyColor", label: "key color", kind: "color", get: () => "#" + key.color.getHexString(), set: (v) => key.color.set(v) },
  { key: "rim", label: "rim", kind: "num", min: 0, max: 3, step: 0.01, get: () => rim.intensity, set: (v) => { rim.intensity = v; } },
  { key: "bloomStrength", label: "bloom strength", kind: "num", min: 0, max: 3, step: 0.01, get: () => bloom.strength, set: (v) => { bloom.strength = v; } },
  { key: "bloomRadius", label: "bloom radius", kind: "num", min: 0, max: 1, step: 0.01, get: () => bloom.radius, set: (v) => { bloom.radius = v; } },
  { key: "bloomThreshold", label: "bloom threshold", kind: "num", min: 0, max: 1, step: 0.01, get: () => bloom.threshold, set: (v) => { bloom.threshold = v; } },
  { key: "fogColor", label: "fog color", kind: "color", get: () => "#" + (scene.fog as THREE.Fog).color.getHexString(), set: (v) => (scene.fog as THREE.Fog).color.set(v) },
  { key: "fogNear", label: "fog near", kind: "num", min: 0, max: 1500, step: 1, get: () => (scene.fog as THREE.Fog).near, set: (v) => { (scene.fog as THREE.Fog).near = v; } },
  { key: "fogFar", label: "fog far", kind: "num", min: 0, max: 4000, step: 1, get: () => (scene.fog as THREE.Fog).far, set: (v) => { (scene.fog as THREE.Fog).far = v; } },
] });

installOutlineDevControls(); // DEV: [ / ] rescale every cel-shade outline live; window.__outline(x)

// ── the race sim (all race logic + HUD/bet-panel/cam-controls DOM live here now) ──────────────
// `game` is created asynchronously in chain mode: the book must have a snapshot BEFORE race-mode sees
// it, or race-mode falls back to its local 15s market for a frame over a chain that may be mid-race.
let game: RaceGame | null = null;

/** A one-line banner naming exactly which chain, which program and which book is on screen — so a
 *  screenshot of this page is self-evidencing rather than something to be taken on trust. */
function chainBanner(text: string, ok: boolean): HTMLElement {
  const el = document.getElementById("chain-banner") ?? document.createElement("div");
  el.id = "chain-banner";
  el.style.cssText = `position:fixed;left:14px;bottom:14px;z-index:60;max-width:min(560px,60vw);padding:8px 12px;border-radius:10px;font:11px/1.5 'Chakra Petch',ui-monospace,monospace;color:${ok ? "#9ad7ff" : "#ff8fa3"};background:rgba(9,6,22,.86);border:1px solid ${ok ? "rgba(122,90,220,.5)" : "rgba(255,93,160,.6)"};white-space:pre-wrap;word-break:break-all;pointer-events:none;`;
  el.textContent = text;
  if (!el.parentElement) document.body.appendChild(el);
  return el;
}

async function makeChainBook(): Promise<RaceBookSource> {
  const wallet = portToAnchorWallet(createDevKeypairPort());
  const client = createPaddockBook({ wallet, mint: CHAIN.PADDOCK_BOOK_MINT });
  // Absent in read-only mode, which is what makes `onboarding()` null and the BET button gate purely
  // on the balance on screen.
  const staging = betMode ? createPaddockStaging({ client }) : undefined;
  const book = await createChainBookSource(client, {
    onError: (where, e) => console.warn("[race-preview] chain book", where, e),
    staging,
  });
  // Stage on ENTRY, never on the tap: the seat is built while the harness boots, so by the time a
  // market is open the BET button is one ER send. Fire-and-forget — the controller throttles itself
  // and reports progress through `book.onboarding()`.
  staging?.ensure(DEV_DEPOSIT_LAMPORTS);
  chainBanner(
    `CHAIN MODE · devnet\nprogram ${CHAIN.PADDOCK_PROGRAM_ID.toBase58()}\nmint    ${CHAIN.PADDOCK_BOOK_MINT.toBase58()}\nrace    ${client.pdas.race.toBase58()}\nER      ${CHAIN.ER_RPC}\nwallet  ${client.address} ${betMode ? `(BETTING — stages a seat against ${Number(DEV_DEPOSIT_LAMPORTS) / 1e9} SOL bets)` : "(read-only — no bettor joined)"}`,
    true,
  );
  // DEV: the client itself. The panel has no claim button — the program settles a winning ticket on
  // the player's NEXT bet, so `claim()` is the only way to collect without staking again, and this
  // harness has to be able to reach it. Same shape as main.ts's `window.__chain`.
  if (betMode) (window as unknown as { __paddock: typeof client }).__paddock = client;
  return book;
}

async function boot(): Promise<void> {
  const book = chainMode ? await makeChainBook() : undefined;
  game = createRaceGame({
    scene,
    camera,
    hudParent: document.body,
    grid: DEFAULT_GRID,
    seed: Date.now() % 100000,
    lowTier: false,
    devHooks: true, // installs window.__raceState / __warp for verification
    book,
  });
  // DEV: the game itself, so a frame can be driven by hand. This pane serves the page HIDDEN —
  // `document.hidden` is true, requestAnimationFrame never fires, and the nextFrame() setTimeout
  // fallback is throttled to roughly 1Hz — so verifying anything visual needs a pump that browser
  // background-throttling does not reach. Chain mode makes this safe: the sim's position is a pure
  // function of the book's remaining seconds, so pumping catches the show UP to the chain rather
  // than running it ahead of one.
  (window as unknown as { __raceGame: RaceGame }).__raceGame = game;
  // sync the initial art style now the toon'd/variant-bearing roots (track + environment, built inside
  // createRaceGame) exist: applies material/hull/geometry-variant state, sets the `toon-ui` body class,
  // and fires applyStyleFog.
  refreshToonStyle();
  nextFrame(loop);
}
// A chain that will not load is a LOUD failure here, not a silent fall-back to the browser sim: the
// entire point of ?chain=1 is that what you are looking at came off the chain.
boot().catch((e) => {
  console.error("[race-preview] boot failed", e);
  chainBanner(`CHAIN MODE FAILED\n${e instanceof Error ? e.message : String(e)}`, false);
});

addEventListener("resize", () => {
  renderer.setSize(vw(), vh());
  camera.aspect = vw() / vh();
  camera.updateProjectionMatrix();
  composer.setSize(vw(), vh());
  bloom.setSize(vw(), vh());
  edgePass.setSize(vw(), vh());
});

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

let last = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000); // clamp so a long stall never teleports cars
  last = now;
  game?.update(dt);   // step + poses + director + track/env + HUD push (all inside the sim module)
  composer.render();  // bloom composite
  nextFrame(loop);
}
// The ticker starts from boot() once the game exists (chain mode has to await its first snapshot).
