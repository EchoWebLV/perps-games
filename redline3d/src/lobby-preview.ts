// Design-preview harness (dev-only, not part of the game): renders the real createLobby() so the
// four themed corner buildings can be surveyed with a free camera. Point the camera from the
// browser console with __cam('overview'|'garage'|'track'|'upgrades'|'crates'). The layout +
// builders are the exact ones the game uses, so this faithfully previews the in-lobby result.
import * as THREE from "three";
import { createLobby } from "./render/lobby";
import { BUILDINGS, LOT_BOUNDS } from "./core/lobby-layout";
import { getOutlineWidth, setOutlineWidth, getWorldRampBand, setWorldRampBand } from "./render/toon";
import { registerLightLab } from "./ui/light-lab";

// Some headless preview viewports report innerWidth/innerHeight as 0 — fall back to a fixed size.
const vw = () => innerWidth || 1280;
const vh = () => innerHeight || 800;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(vw(), vh());
renderer.domElement.style.display = "block";
renderer.domElement.style.width = "100vw";
renderer.domElement.style.height = "100vh";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05030f);
const camera = new THREE.PerspectiveCamera(58, vw() / vh(), 0.1, 4000);

const lobby = createLobby();
scene.add(lobby.group);
lobby.show();

// DEV Light Lab (key L / ?lightlab=1): the "lobby" folder registers itself from createLobby(); this
// harness adds the shared toon Global knobs (this preview has no bloom/edge composer).
registerLightLab("Global", { controls: [
  { key: "exposure", label: "exposure", kind: "num", min: 0, max: 3, step: 0.01, get: () => renderer.toneMappingExposure, set: (v) => { renderer.toneMappingExposure = v; } },
  { key: "outlineScale", label: "outline scale", kind: "num", min: 0, max: 3, step: 0.05, get: () => getOutlineWidth(), set: (v) => setOutlineWidth(v) },
  { key: "rampFloor", label: "toon ramp floor", kind: "color", get: () => getWorldRampBand(0), set: (v) => setWorldRampBand(0, v) },
  { key: "rampBand2", label: "toon ramp band 2", kind: "color", get: () => getWorldRampBand(1), set: (v) => setWorldRampBand(1, v) },
] });

function view(cx: number, cy: number, cz: number, tx: number, ty: number, tz: number) {
  camera.position.set(cx, cy, cz);
  camera.lookAt(tx, ty, tz);
}

// 3/4 view from the plaza side of a building (in front of its facing), derived from its live pose.
function lookBuilding(kind: string) {
  const b = BUILDINGS.find((x) => x.kind === kind);
  if (!b) return overview();
  const fx = Math.sin(b.rot), fz = Math.cos(b.rot); // building front direction in world space
  const dist = 34, height = 16;
  view(b.x + fx * dist + 6, height, b.z + fz * dist + 6, b.x, 9, b.z);
}
// high overview looking north across the plaza at the arc of buildings.
function overview() { const s = LOT_BOUNDS.z; view(0, s * 1.35, s * 1.15, 0, 0, -s * 0.38); }
function garage() { lookBuilding("garage"); }
function track() { lookBuilding("track"); }
function upgrades() { lookBuilding("upgrades"); }
function crates() { lookBuilding("crates"); }
function highway() { lookBuilding("highway"); }
const PRESETS = { overview, garage, track, upgrades, crates, highway };

type CamKey = keyof typeof PRESETS;
(window as unknown as { __cam: (k: string) => void }).__cam = (k) => {
  (PRESETS[k as CamKey] ?? overview)();
};
(window as unknown as { __view: typeof view }).__view = view;

overview();

addEventListener("resize", () => {
  renderer.setSize(vw(), vh());
  camera.aspect = vw() / vh();
  camera.updateProjectionMatrix();
});

// cycle the entry-ring flare across the buildings so the active state can be surveyed too
const KINDS = BUILDINGS.map((b) => b.kind);
let elapsed = 0;

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;
  lobby.setActiveDoor(KINDS[Math.floor(elapsed / 2.5) % KINDS.length]);
  lobby.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
