// measure-cars.mjs — size audit for every roster car GLB.
//
//   node scripts/measure-cars.mjs          # human table
//   node scripts/measure-cars.mjs --json   # machine output
//
// Reproduces the exact in-game normalization (car.ts / stripcars.ts:
// longest horizontal bbox axis → TARGET_LEN × per-car scale) and reports the
// resulting road-frame Length × Width × Height per car. Also computes a
// decoration-robust "body" box (1st–99th vertex percentile per axis) so a
// tail, ladder or antenna that inflates the bbox — and therefore shrinks the
// whole car in game — shows up as a low body/bbox ratio.
import { NodeIO } from "@gltf-transform/core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(SCRIPTS, "../public/models");
const TARGET_LEN = 11.23; // keep in sync with car.ts / stripcars.ts

// partial volume correction — keep in sync with src/render/car-scale.ts (scripts can't import TS).
// After length normalization, nudge each car's rendered visual mass toward the roster median so
// boxy models stop towering over flat ones; clamped so length never drifts absurdly.
const REF_LEN = 11.23, MASS_TARGET = 6.9, MASS_EXP = 0.5, CORR_MIN = 0.8, CORR_MAX = 1.15;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function carNormScale(size, targetLen, mul = 1) {
  const sLen = (targetLen / (Math.max(size.x, size.z) || 1)) * mul;
  const vol = size.x * size.y * size.z;
  const mass = Math.cbrt(vol) * sLen;
  const target = MASS_TARGET * (targetLen / REF_LEN);
  const corr = vol > 0 ? clamp((target / mass) ** MASS_EXP, CORR_MIN, CORR_MAX) : 1;
  return sLen * corr;
}

// mirror of CAR_DEFS in main.ts (name, glb, per-car scale multiplier, yaw quarter-turns)
const ROSTER = [
  { name: "DeLorean",     glb: "delorean.glb",      scale: 1,    turn: 0 },
  { name: "Cybertruck",   glb: "cybertruck.glb",    scale: 1.3,  turn: 0 },
  { name: "Orion",        glb: "orion.glb",         scale: 1.2,  turn: 1 },
  { name: "Vaporwave",    glb: "vaporwave.glb",     scale: 1,    turn: 0 },
  { name: "Bedrock",      glb: "flintstone.glb",    scale: 0.7,  turn: 0 },
  { name: "Clown Car",    glb: "clown-car.glb",     scale: 1,    turn: 1 },
  { name: "Skull",        glb: "skull.glb",         scale: 1,    turn: 1 },
  { name: "Slot Machine", glb: "slot-machine.glb",  scale: 1,    turn: 1 },
  { name: "Cart Rod",     glb: "shopping-cart.glb", scale: 0.65, turn: 1 },
  { name: "Magnet",       glb: "magnet.glb",        scale: 0.75, turn: 1 },
  { name: "Helmet",       glb: "helmet.glb",        scale: 1,    turn: 1 },
  { name: "Pink Rod",     glb: "pink-rod.glb",      scale: 1,    turn: 1 },
  { name: "Six Wheeler",  glb: "six-wheeler.glb",   scale: 1,    turn: 1 },
  { name: "Banana",       glb: "banana.glb",        scale: 1,    turn: 1 },
  { name: "Cook Wagon",   glb: "breaking_rv.glb",   scale: 1.7,  turn: 0 },
  { name: "Trabbi",       glb: "trabant.glb",       scale: 1,    turn: 1 },
  { name: "Big Frank",    glb: "wiener.glb",        scale: 1,    turn: 1 },
  { name: "Dragon",       glb: "dragon.glb",        scale: 1,    turn: 1 },
  { name: "Homewrecker",  glb: "house.glb",         scale: 1,    turn: 1 },
  { name: "Copycat",      glb: "cat.glb",           scale: 1,    turn: 1 },
  { name: "Knockout",     glb: "knockout.glb",      scale: 1,    turn: 1 },
  { name: "Prickle",      glb: "cactus.glb",        scale: 1,    turn: 1 },
  { name: "The Kraken",   glb: "kraken.glb",        scale: 1,    turn: 1 },
  { name: "Noodler",      glb: "ramen.glb",         scale: 1,    turn: 1 },
  { name: "Starter",      glb: "starter.glb",       scale: 1,    turn: 1 },
];

const io = new NodeIO();

// world-space vertex sweep: node world matrix × every POSITION element.
// CAVEAT: skinned meshes (delorean.glb) are measured in BIND POSE here, but the
// game's three.js Box3.setFromObject uses SkinnedMesh.computeBoundingBox — the
// POSED box — so the delorean row below is wrong (bind pose is ~25 units tall).
// Live-verified 2026-07-08: in-engine the delorean is 11.23×4.93×3.80 and the
// volume correction grows it ×1.077. Every unskinned car matches the live engine
// to 3 decimals.
function collectVerts(scene) {
  const xs = [], ys = [], zs = [];
  const walk = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute("POSITION");
        if (!pos) continue;
        const el = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, el);
          const [x, y, z] = el;
          xs.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
          ys.push(m[1] * x + m[5] * y + m[9] * z + m[13]);
          zs.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
      }
    }
    for (const child of node.listChildren()) walk(child);
  };
  for (const node of scene.listChildren()) walk(node);
  return { xs, ys, zs };
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

function axisStats(arr) {
  const s = Float64Array.from(arr).sort();
  return { min: s[0], max: s[s.length - 1], p1: pct(s, 0.01), p99: pct(s, 0.99) };
}

const rows = [];
for (const car of ROSTER) {
  const doc = await io.read(resolve(MODELS, car.glb));
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const { xs, ys, zs } = collectVerts(scene);
  const X = axisStats(xs), Y = axisStats(ys), Z = axisStats(zs);
  const raw = { x: X.max - X.min, y: Y.max - Y.min, z: Z.max - Z.min };
  const body = { x: X.p99 - X.p1, y: Y.p99 - Y.p1, z: Z.p99 - Z.p1 };

  // exact in-game normalization (car.ts loadModel): legacy length-only, and the shipped
  // length-plus-volume-correction scale (car-scale.ts) — both fed the SAME raw bbox the game uses
  const s = (TARGET_LEN / (Math.max(raw.x, raw.z) || 1)) * car.scale;
  const sc = carNormScale(raw, TARGET_LEN, car.scale);
  // road frame: a quarter-turn yaw swaps which raw axis lies along the road
  const road = (v) => (car.turn ? { len: v.x, wid: v.z } : { len: v.z, wid: v.x });
  const bb = road(raw), bd = road(body);
  rows.push({
    name: car.name, glb: car.glb, scaleMul: car.scale, verts: xs.length,
    // what the game renders (bbox basis) — legacy length-only normalization
    len: bb.len * s, wid: bb.wid * s, hgt: raw.y * s,
    // …and with the shipped partial volume correction (car-scale.ts) — the real in-game size
    corrLen: bb.len * sc, corrWid: bb.wid * sc, corrHgt: raw.y * sc,
    corr: sc / s, // the applied correction factor (clamped CORR_MIN..CORR_MAX)
    // decoration-robust body size in the same world units, legacy scale then corrected
    bodyLen: bd.len * s, bodyWid: bd.wid * s, bodyHgt: body.y * s,
    corrBodyLen: bd.len * sc, corrBodyWid: bd.wid * sc, corrBodyHgt: body.y * sc,
    // how much of the bbox is actually body (1.0 = clean box, low = decoration-inflated)
    bodyFrac: Math.min(bd.len / bb.len, bd.wid / bb.wid, body.y / raw.y),
  });
}

// visual mass proxy: cbrt of the body box volume — closest single number to "how big it feels".
// bbox mass is the same proxy on the full bounding box — the quantity the correction actually
// targets (MASS_TARGET), so it's what converges to ~6.9 below.
for (const r of rows) {
  r.mass = Math.cbrt(r.bodyLen * r.bodyWid * r.bodyHgt);
  r.corrMass = Math.cbrt(r.corrBodyLen * r.corrBodyWid * r.corrBodyHgt);
  r.bboxMass = Math.cbrt(r.len * r.wid * r.hgt);
  r.corrBboxMass = Math.cbrt(r.corrLen * r.corrWid * r.corrHgt);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const f = (n) => n.toFixed(2).padStart(6);
  const m = (n) => n.toFixed(2).padStart(5);
  // before → after in one table: legacy length-only L×W×H vs the corrected (shipped) L×W×H, the
  // applied correction factor, and the body-mass "feel" moving legacy → corrected
  console.log("car            |  legacy L×W×H (render)   | corrected L×W×H (render) | body | corr  |  mass→corr");
  console.log("---------------+--------------------------+--------------------------+------+-------+------------");
  for (const r of [...rows].sort((a, b) => b.mass - a.mass)) {
    console.log(
      `${r.name.padEnd(14)} | ${f(r.len)} ${f(r.wid)} ${f(r.hgt)} | ${f(r.corrLen)} ${f(r.corrWid)} ${f(r.corrHgt)} | ${(r.bodyFrac * 100).toFixed(0).padStart(3)}% | ${r.corr.toFixed(3)} | ${m(r.mass)}→${m(r.corrMass)}`
    );
  }
  const stat = (key) => {
    const v = rows.map((r) => r[key]).sort((a, b) => a - b);
    return { med: v[Math.floor(v.length / 2)], ratio: v[v.length - 1] / v[0] };
  };
  const bodyL = stat("mass"), bodyC = stat("corrMass");
  const boxL = stat("bboxMass"), boxC = stat("corrBboxMass");
  console.log(`\n                 body-mass (feel)        bbox-mass (correction target → ${MASS_TARGET})`);
  console.log(`legacy         : median ${m(bodyL.med)}  spread ${bodyL.ratio.toFixed(1)}×      median ${m(boxL.med)}  spread ${boxL.ratio.toFixed(1)}×`);
  console.log(`corrected      : median ${m(bodyC.med)}  spread ${bodyC.ratio.toFixed(1)}×      median ${m(boxC.med)}  spread ${boxC.ratio.toFixed(1)}×`);
  console.log(`\n⚠ DeLorean row is bind-pose (skinned GLB) — in-engine it's 11.23×4.93×3.80, corr ×1.077. See CAVEAT above collectVerts.`);
}
