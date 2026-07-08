// rig-wheels.mjs — one-time wheel auto-rig for all car GLBs.
//
// Detects wheels three ways and normalizes them all to one contract:
//   - welded single meshes (most models): ground-contact clustering + circle
//     fit, then the wheel triangles are CUT into a new node
//   - plain wheel-named nodes (flintstone): TAGGED in place (pivot kept)
//   - skinned wheel joints (delorean): TAGGED in place (bones can't move)
//
// Contract after rigging — every wheel is a node/joint named `wheel_N` with
//   extras.perpsWheel = { radius, axle:[x,y,z], up:[x,y,z] }
// where radius is in scene units and axle/up are NODE-LOCAL directions. The
// runtime composes rest-pose × steer(up) × spin(axle). Cut wheels get pivot
// at the hub and identity axes (axle=[1,0,0], up=[0,1,0]).
//
//   node scripts/rig-wheels.mjs --dry            # detect + report only
//   node scripts/rig-wheels.mjs                  # rig + overwrite all models
//   node scripts/rig-wheels.mjs --model skull    # one model
//   node scripts/rig-wheels.mjs --verify         # re-open outputs, assert rigged
import { NodeIO } from "@gltf-transform/core";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";

const MODELS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/models");

// Regression table — detection must find exactly this many wheels per model.
const EXPECTED = {
  "clown-car": 4, cybertruck: 4, delorean: 4, flintstone: 2, helmet: 4,
  // magnet: 4-wheeled hot-rod (thin front, fat rear); side-view circles each cover a L/R pair
  magnet: 4,
  // shopping-cart: dual rear wheels per side (inner+outer split by the basket) = 6 groups
  orion: 2, "pink-rod": 4, "shopping-cart": 4, "six-wheeler": 6,
  skull: 4, "slot-machine": 4, starter: 4, vaporwave: 4,
  // new common cars — 2 side-view circles each (L/R pair) = 4 wheels. banana still unmarked.
  breaking_rv: 4, cactus: 4, cat: 4, dragon: 4, house: 4, knockout: 4, ramen: 4, trabant: 4, wiener: 4,
  // kraken: only the REAR axle marked so far (1 circle → 2 wheels); front axle pending a circle → bump to 4 then.
  kraken: 2,
};
// delorean/flintstone: welded-detection fails (0 / noisy clusters) but they
// have proper wheel nodes/joints — the named path handles them. orion's
// wheel_f/wheel_b are coaxial AXLE-PAIR nodes (2 nodes, 4 tires): tagging
// them is 1:1 by construction, better than any fit.
const NAMED_PATH = new Set(["delorean", "flintstone", "orion"]);
// cybertruck: wheels are separate (unnamed) mesh nodes — the node IS the
// wheel, so shape-test nodes instead of fitting circles.
const NODE_SHAPE_PATH = new Set(["cybertruck"]);
// vaporwave: wheels are 4 disjoint triangle ISLANDS inside one merged mesh —
// connected-component split finds them exactly.
const ISLAND_PATH = new Set(["vaporwave"]);
const WHEEL_NAME = /wheel|tire|tyre/i;
const NOT_WHEEL = /steering|body/i;

// ---------- linear algebra helpers (column-major mat4, like glTF) ----------
const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
// inverse-transpose of the 3x3 (normals), normalized on use
function normalMat3(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [A / det, B / det, C / det,
          (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det,
          (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det];
}
function mat4mul(a, b) { // column-major a×b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
// scene direction -> node-local direction: v_local = R^T v (R = normalized world 3x3)
function sceneDirToLocal(worldMat, v) {
  const cols = [
    [worldMat[0], worldMat[1], worldMat[2]],
    [worldMat[4], worldMat[5], worldMat[6]],
    [worldMat[8], worldMat[9], worldMat[10]],
  ].map((c) => { const l = Math.hypot(...c) || 1; return c.map((x) => x / l); });
  return [0, 1, 2].map((i) => cols[i][0] * v[0] + cols[i][1] * v[1] + cols[i][2] * v[2]);
}
// scene vector -> local units: inverse of the world 3x3 (incl. scale) applied to v
function sceneVecToLocal(m, v) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [
    (A * v[0] + (c * h - b * i) * v[1] + (b * f - c * e) * v[2]) / det,
    (B * v[0] + (a * i - c * g) * v[1] + (c * d - a * f) * v[2]) / det,
    (C * v[0] + (b * g - a * h) * v[1] + (a * e - b * d) * v[2]) / det,
  ];
}

// Slide a TAGGED wheel's pivot along the scene axle by w.axleShift WITHOUT
// moving any rendered geometry: the node translation moves; a skinned joint
// gets the inverse translation folded into its inverse-bind matrix, a plain
// node gets its mesh re-hung on a counter-shifted carrier child (and any
// child nodes nudged back). Rest pose is bit-identical by construction —
// only the steer/spin pivot relocates.
function slidePivot(doc, w) {
  const node = w.tagNode;
  const D = [0, 0, 0];
  D[w.axleAxis] = w.axleShift;
  const dLocal = sceneVecToLocal(node.getWorldMatrix(), D);
  const parentNode = node.listParents().find((p) => p.propertyType === "Node") ?? null;
  const dParent = parentNode ? sceneVecToLocal(parentNode.getWorldMatrix(), D) : D.slice();
  const t = node.getTranslation();
  node.setTranslation([t[0] + dParent[0], t[1] + dParent[1], t[2] + dParent[2]]);
  const skins = doc.getRoot().listSkins().filter((s) => s.listJoints().includes(node));
  for (const skin of skins) {
    const j = skin.listJoints().indexOf(node);
    const acc = skin.getInverseBindMatrices();
    const arr = acc.getArray().slice();
    arr[j * 16 + 12] -= dLocal[0]; arr[j * 16 + 13] -= dLocal[1]; arr[j * 16 + 14] -= dLocal[2];
    acc.setArray(arr);
  }
  for (const c of node.listChildren()) {
    const ct = c.getTranslation();
    c.setTranslation([ct[0] - dLocal[0], ct[1] - dLocal[1], ct[2] - dLocal[2]]);
  }
  if (node.getMesh() && !skins.length) {
    const carrier = doc.createNode(`${node.getName()}_geo`)
      .setTranslation([-dLocal[0], -dLocal[1], -dLocal[2]])
      .setMesh(node.getMesh());
    node.setMesh(null);
    node.addChild(carrier);
  }
}

// ---------- gather the triangle soup (scene space) ----------
// Each entry: { prim, node, wheelRoot, matrix, nmat, pos, idx, joints, weights, skinJoints }
function gatherPrims(doc) {
  const prims = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const visit = (node, wheelRoot) => {
    const name = node.getName() || "";
    if (WHEEL_NAME.test(name) && !NOT_WHEEL.test(name)) wheelRoot = wheelRoot ?? node;
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      const skin = node.getSkin();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // TRIANGLES only
        const pos = prim.getAttribute("POSITION").getArray();
        const idxAcc = prim.getIndices();
        let idx;
        if (idxAcc) idx = Uint32Array.from(idxAcc.getArray());
        else { idx = new Uint32Array(pos.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i; }
        prims.push({
          prim, node, wheelRoot, matrix: m, nmat: normalMat3(m), pos, idx,
          joints: prim.getAttribute("JOINTS_0")?.getArray() ?? null,
          weights: prim.getAttribute("WEIGHTS_0")?.getArray() ?? null,
          skinJoints: skin ? skin.listJoints() : null,
          skinIBM: skin ? skin.getInverseBindMatrices()?.getArray() ?? null : null,
        });
      }
    }
    for (const c of node.listChildren()) visit(c, wheelRoot);
  };
  for (const n of scene.listChildren()) visit(n, null);
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
    for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
  }
  return { prims, mn, mx };
}

// scene-space vertex soup (flat [x,y,z,...]) — built once, reused
function worldVerts(prims) {
  let total = 0;
  for (const p of prims) total += p.pos.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
    out[o++] = w[0]; out[o++] = w[1]; out[o++] = w[2];
  }
  return out;
}

// ---------- geometry-path detection (welded meshes) ----------
// Wheels are the only geometry touching the ground: cluster the bottom 2.5%
// of vertices in XZ (one cluster per wheel), infer the length axis from hub
// spread, then circle-fit each wheel's rolling profile for hub y + radius.
// Returns [{ hub:[x,y,z], radius, axleAxis: 0|2, halfWidth }]
function detectByGround(wv, mn, mx) {
  const H = mx[1] - mn[1], L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  const nv = wv.length / 3;
  const clusters = [];
  for (let i = 0; i < nv; i++) {
    if (wv[i * 3 + 1] > mn[1] + 0.025 * H) continue;
    const x = wv[i * 3], z = wv[i * 3 + 2];
    let c = clusters.find((c) => Math.hypot(c.sx / c.n - x, c.sz / c.n - z) < 0.09 * L);
    if (c) { c.sx += x; c.sz += z; c.n++; } else clusters.push({ sx: x, sz: z, n: 1 });
  }
  const hubs = clusters.filter((c) => c.n >= 8).map((c) => ({ x: c.sx / c.n, z: c.sz / c.n }));
  if (hubs.length < 2) return [];
  // length axis = horizontal axis with larger hub spread; axle = the other
  const spread = (k) => Math.max(...hubs.map((h) => h[k])) - Math.min(...hubs.map((h) => h[k]));
  const lengthAxis = spread("x") >= spread("z") ? 0 : 2; // 0=x, 2=z
  const axleAxis = lengthAxis === 0 ? 2 : 0;
  // circle fit per hub, in the (lengthAxis, y) plane, slab along axleAxis.
  // A tire is a FULL circle tangent to the ground; a fender arc or a rim ring
  // is not. Scan r from large to small and take the LARGEST circle with full
  // angular coverage — that is the tire's outer edge (1:1 with the model),
  // not the rim circle a density score would lock onto.
  const BAND = 0.012 * L;
  const wheels = [];
  for (const h of hubs) {
    const ha = axleAxis === 0 ? h.x : h.z;   // hub coord along axle
    const hl = lengthAxis === 0 ? h.x : h.z; // hub coord along length
    // slab verts once per hub: [l, y, a]
    const pts = [];
    for (let i = 0; i < nv; i++) {
      if (Math.abs(wv[i * 3 + axleAxis] - ha) > 0.06 * L) continue;
      if (Math.abs(wv[i * 3 + lengthAxis] - hl) > 0.34 * L) continue;
      pts.push(wv[i * 3 + lengthAxis], wv[i * 3 + 1], wv[i * 3 + axleAxis]);
    }
    let best = null;
    for (let r = 0.30 * L; r >= 0.008 * L && !best; r -= 0.002 * L) {
      for (let dl = -0.03 * L; dl <= 0.03 * L; dl += 0.006 * L) {
        const y0 = mn[1] + r, l0 = hl + dl; // tangent to the ground by construction
        // coverage counts the band just INSIDE the circle: inside a tire's
        // outer edge there is tread in every direction; inside a wheel-arch
        // circle (also ground-tangent — they nest!) there is mostly air.
        let inl = 0;
        const bins = new Array(24).fill(0);
        for (let k = 0; k < pts.length; k += 3) {
          const dll = pts[k] - l0, dy = pts[k + 1] - y0;
          const d = Math.hypot(dy, dll);
          if (d > r + BAND * 0.25 || d < r - BAND * 2) continue;
          inl++;
          bins[Math.floor(((Math.atan2(dy, dll) + Math.PI) / (2 * Math.PI)) * 24) % 24]++;
        }
        const coverage = bins.filter((b) => b >= 2).length;
        if (inl >= 80 && coverage >= 21) { best = { r, l0, y0, inl }; break; }
      }
    }
    if (!best) continue;
    // acceptance extends up to ~2×BAND past the true edge — bias-center it
    let r = best.r - BAND;
    // independent cross-check, immune to side-junk: walking straight UP from
    // the contact point, the tire is a solid column until its top, then the
    // wheel-well air gap — first sustained gap height = true diameter
    const colYs = [];
    for (let k = 0; k < pts.length; k += 3) {
      if (Math.abs(pts[k] - best.l0) < 0.035 * L) colYs.push(pts[k + 1]);
    }
    colYs.sort((a, b) => a - b);
    let rVert = null;
    for (let k = 1; k < colYs.length; k++) {
      if (colYs[k] - colYs[k - 1] > 0.025 * L) { rVert = (colYs[k - 1] - mn[1]) / 2; break; }
    }
    if (rVert && rVert > 0.02 * L && Math.abs(r - rVert) > 0.15 * Math.max(r, rVert)) r = rVert;
    best = { ...best, r, y0: mn[1] + r };
    // wheel width: axle extent of everything inside the wheel cylinder
    // (2nd–98th percentile so a stray weld can't stretch it)
    const axleCoords = [];
    for (let k = 0; k < pts.length; k += 3) {
      if (Math.hypot(pts[k] - best.l0, pts[k + 1] - best.y0) < best.r * 0.99) axleCoords.push(pts[k + 2]);
    }
    axleCoords.sort((a, b) => a - b);
    const lo = axleCoords[Math.floor(axleCoords.length * 0.02)] ?? ha;
    const hi = axleCoords[Math.floor(axleCoords.length * 0.98)] ?? ha;
    const hub = [0, best.y0, 0]; hub[axleAxis] = (lo + hi) / 2; hub[lengthAxis] = best.l0;
    wheels.push({ hub, radius: best.r, axleAxis, halfWidth: Math.max((hi - lo) / 2, best.r * 0.15), inliers: best.inl });
  }
  // merge overlapping candidates (shopping-cart double-detects its casters):
  // two hubs closer than ~the larger radius = the same wheel; keep the better fit
  wheels.sort((a, b) => b.inliers - a.inliers);
  const merged = [];
  for (const w of wheels) {
    if (merged.some((m) => Math.hypot(m.hub[0] - w.hub[0], m.hub[1] - w.hub[1], m.hub[2] - w.hub[2]) < (m.radius + w.radius) * 0.5)) continue;
    merged.push(w);
  }
  return merged;
}

// ---------- named-path detection (delorean joints, flintstone nodes) ----------
// A wheel = a wheel-named node. Its member vertices are either the prims under
// it (plain nodes) or the skinned vertices dominantly weighted to it (joints).
// Hub = node pivot (these models steer around it today); radius from the
// members' bbox height; axle = the horizontal dim that does NOT match dy.
function detectByName(doc, prims) {
  const roots = new Map(); // wheel node -> member scene-space verts (array of [x,y,z])
  const rootPrims = new Map(); // wheel node -> prim entries (plain nodes only; joints have none)
  // plain-node members
  for (const p of prims) {
    if (!p.wheelRoot) continue;
    if (!roots.has(p.wheelRoot)) { roots.set(p.wheelRoot, []); rootPrims.set(p.wheelRoot, []); }
    rootPrims.get(p.wheelRoot).push(p);
    const list = roots.get(p.wheelRoot);
    for (let i = 0; i < p.pos.length; i += 3) list.push(xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]));
  }
  // joint members (skinned meshes) — skinned verts ignore the mesh node's
  // transform; their scene position is jointWorld × inverseBind × pos
  for (const p of prims) {
    if (!p.joints || !p.skinJoints || !p.skinIBM) continue;
    const jointXf = new Map(); // joint index -> mat4 (world × invBind)
    const jointMat = (j) => {
      let m = jointXf.get(j);
      if (!m) {
        const w = p.skinJoints[j].getWorldMatrix();
        const ib = p.skinIBM.slice(j * 16, j * 16 + 16);
        m = mat4mul(w, ib);
        jointXf.set(j, m);
      }
      return m;
    };
    for (let v = 0; v < p.pos.length / 3; v++) {
      // dominant joint of this vertex
      let bj = -1, bw = 0;
      for (let k = 0; k < 4; k++) { const w = p.weights[v * 4 + k]; if (w > bw) { bw = w; bj = p.joints[v * 4 + k]; } }
      if (bj < 0 || bw < 0.5) continue;
      const jn = p.skinJoints[bj];
      const name = jn?.getName() || "";
      if (!WHEEL_NAME.test(name) || NOT_WHEEL.test(name)) continue;
      if (!roots.has(jn)) roots.set(jn, []);
      roots.get(jn).push(xform(jointMat(bj), p.pos[v * 3], p.pos[v * 3 + 1], p.pos[v * 3 + 2]));
    }
  }
  const wheels = [];
  for (const [node, verts] of roots) {
    if (verts.length < 40) continue;
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const w of verts) for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    const dx = mx[0] - mn[0], dy = mx[1] - mn[1], dz = mx[2] - mn[2];
    const axleAxis = Math.abs(dx - dy) > Math.abs(dz - dy) ? 0 : 2; // dim farther from dy
    const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const wm = node.getWorldMatrix();
    const pivot = [wm[12], wm[13], wm[14]];
    // A pivot off-center in the ROLLING plane makes the wheel orbit instead of
    // spin (flintstone's back roller pivots at the log frame, 47% of r off).
    // Tag only when the pivot truly sits on the axle line; otherwise extract
    // into a fresh hub-pivoted node. Joints can't be extracted (skinned verts).
    const rollAxes = axleAxis === 0 ? [1, 2] : [1, 0];
    const offRoll = Math.hypot(pivot[rollAxes[0]] - center[rollAxes[0]], pivot[rollAxes[1]] - center[rollAxes[1]]);
    const isJoint = !rootPrims.has(node);
    if (isJoint) {
      if (offRoll > dy * 0.125) throw new Error(`${node.getName()}: joint pivot ${offRoll.toFixed(2)} off the axle line (dy=${dy.toFixed(2)}) — cannot extract skinned verts`);
      wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: (axleAxis === 0 ? dx : dz) / 2, tagNode: node, isJoint: true, memberVerts: verts, pivot });
    } else if (offRoll <= dy * 0.025) {
      wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: (axleAxis === 0 ? dx : dz) / 2, tagNode: node, memberVerts: verts, pivot });
    } else {
      wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: (axleAxis === 0 ? dx : dz) / 2, srcPrims: rootPrims.get(node), srcNode: node });
    }
  }
  return wheels;
}

// ---------- node-shape detection (cybertruck, vaporwave) ----------
// Wheels live on their own (unnamed) mesh nodes: shape-test each node's
// scene-space bbox — round side profile, thinner along one horizontal axis,
// sitting at the ground line. The node IS the wheel: 1:1 by construction.
function detectByNodeShape(prims, mn, mx) {
  const H = mx[1] - mn[1], L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  const byNode = new Map();
  for (const p of prims) {
    if (!byNode.has(p.node)) byNode.set(p.node, []);
    byNode.get(p.node).push(p);
  }
  const wheels = [];
  for (const [node, list] of byNode) {
    let bmn = [1e9, 1e9, 1e9], bmx = [-1e9, -1e9, -1e9];
    let count = 0;
    const verts = [];
    for (const p of list) for (let i = 0; i < p.pos.length; i += 3) {
      const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
      count++;
      verts.push(w);
      for (let k = 0; k < 3; k++) { if (w[k] < bmn[k]) bmn[k] = w[k]; if (w[k] > bmx[k]) bmx[k] = w[k]; }
    }
    if (count < 40) continue;
    const dx = bmx[0] - bmn[0], dy = bmx[1] - bmn[1], dz = bmx[2] - bmn[2];
    const rolling = Math.max(dx, dz), width = Math.min(dx, dz);
    if (Math.min(dy, rolling) / Math.max(dy, rolling) < 0.8) continue; // round side profile
    if (width > 0.9 * dy) continue;                                    // has a thin axle axis
    if (dy < 0.04 * L || dy > 0.4 * L) continue;                       // sane size
    if (bmn[1] - mn[1] > 0.12 * H) continue;                           // touches the ground line
    const axleAxis = dx < dz ? 0 : 2;
    const center = [(bmn[0] + bmx[0]) / 2, (bmn[1] + bmx[1]) / 2, (bmn[2] + bmx[2]) / 2];
    const wm = node.getWorldMatrix();
    const pivot = [wm[12], wm[13], wm[14]];
    const rollAxes = axleAxis === 0 ? [1, 2] : [1, 0];
    const offRoll = Math.hypot(pivot[rollAxes[0]] - center[rollAxes[0]], pivot[rollAxes[1]] - center[rollAxes[1]]);
    if (offRoll <= dy * 0.025) wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: width / 2, tagNode: node, memberVerts: verts, pivot });
    else wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: width / 2, srcPrims: list, srcNode: node });
  }
  return wheels;
}

// ---------- rigging ----------
// Tag path: the wheel already lives on its own node/joint — stamp extras with
// the node-LOCAL axle/up directions and rename. Cut path: extract the wheel
// triangles into a new node (pivot at hub, local +X = axle, identity axes).
// Cut rule: a triangle belongs to a wheel when its scene-space centroid is
// inside the wheel cylinder: |along axle − hub| < halfWidth×1.15 + 2%r and
// radial distance in the rolling plane < radius×1.08.
function rigModel(doc, prims, wheels) {
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  // 90° yaw quaternion maps local +X to scene +Z (for axleAxis===2 cut wheels)
  const YAW90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  // scene-space point -> wheel-local (undo hub translation, undo the node's
  // +90° yaw). R⁻¹ for +90° about Y maps (x,y,z) -> (-z, y, x); using R here
  // instead renders every Z-axle wheel 180°-flipped around its hub.
  const toLocal = (w, p) => {
    const x = p[0] - w.hub[0], y = p[1] - w.hub[1], z = p[2] - w.hub[2];
    return w.axleAxis === 0 ? [x, y, z] : [-z, y, x];
  };
  const dirToLocal = (w, v) => (w.axleAxis === 0 ? v : [-v[2], v[1], v[0]]);

  // --- tag path ---
  const finalWheels = [];
  wheels.forEach((w, wi) => {
    if (!w.tagNode) return;
    if (w.axleShift) slidePivot(doc, w);
    const wm = w.tagNode.getWorldMatrix();
    const axleScene = w.axleAxis === 0 ? [1, 0, 0] : [0, 0, 1];
    w.tagNode.setName(`wheel_${wi}`);
    w.tagNode.setExtras({
      ...(w.tagNode.getExtras() ?? {}),
      perpsWheel: {
        radius: w.radius,
        axle: sceneDirToLocal(wm, axleScene),
        up: sceneDirToLocal(wm, [0, 1, 0]),
      },
    });
    finalWheels.push({ node: w.tagNode, hub: w.hub, radius: w.radius, axleAxis: w.axleAxis });
  });
  const cutWheels = wheels.filter((w) => !w.tagNode);
  if (!cutWheels.length) return finalWheels;

  // --- cut path ---
  // per-wheel accumulator: one new primitive per (wheel, source primitive)
  const buckets = cutWheels.map(() => new Map()); // srcPrim entry -> {pos,nrm,uv,idx,remap}
  // whole-node wheels (srcPrims): every triangle of those prims belongs to
  // that wheel — no cylinder test, no leftover risk
  const srcOwner = new Map();
  cutWheels.forEach((w, wi) => { for (const p of w.srcPrims ?? []) srcOwner.set(p, wi); });
  for (const p of prims) {
    const keep = [];
    const hasN = !!p.prim.getAttribute("NORMAL");
    const hasUV = !!p.prim.getAttribute("TEXCOORD_0");
    const nrmArr = hasN ? p.prim.getAttribute("NORMAL").getArray() : null;
    const uvArr = hasUV ? p.prim.getAttribute("TEXCOORD_0").getArray() : null;
    for (let t = 0; t < p.idx.length; t += 3) {
      const ia = p.idx[t], ib = p.idx[t + 1], ic = p.idx[t + 2];
      let cx = 0, cy = 0, cz = 0;
      for (const ii of [ia, ib, ic]) {
        const w = xform(p.matrix, p.pos[ii * 3], p.pos[ii * 3 + 1], p.pos[ii * 3 + 2]);
        cx += w[0] / 3; cy += w[1] / 3; cz += w[2] / 3;
      }
      let hit = srcOwner.has(p) ? srcOwner.get(p) : -1;
      for (let wi = 0; hit < 0 && wi < cutWheels.length; wi++) {
        const w = cutWheels[wi];
        if (w.srcPrims) continue; // whole-node wheels take only their own prims
        if (w.belongs) { if (w.belongs(p, ia)) { hit = wi; break; } continue; } // exact island capture
        const axle = w.axleAxis === 0 ? cx : cz;
        const len = w.axleAxis === 0 ? cz : cx;
        const axleHub = w.axleAxis === 0 ? w.hub[0] : w.hub[2];
        const lenHub = w.axleAxis === 0 ? w.hub[2] : w.hub[0];
        if (Math.abs(axle - axleHub) > w.halfWidth * 1.12 + w.radius * 0.02) continue;
        if (Math.hypot(cy - w.hub[1], len - lenHub) > w.radius * 1.05) continue;
        hit = wi; break;
      }
      if (hit < 0) { keep.push(ia, ib, ic); continue; }
      // move this triangle into the wheel bucket (rebased into wheel-local frame)
      const w = cutWheels[hit];
      let b = buckets[hit].get(p);
      if (!b) { b = { pos: [], nrm: hasN ? [] : null, uv: hasUV ? [] : null, idx: [], remap: new Map() }; buckets[hit].set(p, b); }
      for (const ii of [ia, ib, ic]) {
        let ni = b.remap.get(ii);
        if (ni === undefined) {
          ni = b.pos.length / 3; b.remap.set(ii, ni);
          const sp = xform(p.matrix, p.pos[ii * 3], p.pos[ii * 3 + 1], p.pos[ii * 3 + 2]);
          b.pos.push(...toLocal(w, sp));
          if (hasN) {
            const n = nrmArr, m = p.nmat;
            const nx = m[0] * n[ii * 3] + m[3] * n[ii * 3 + 1] + m[6] * n[ii * 3 + 2];
            const ny = m[1] * n[ii * 3] + m[4] * n[ii * 3 + 1] + m[7] * n[ii * 3 + 2];
            const nz = m[2] * n[ii * 3] + m[5] * n[ii * 3 + 1] + m[8] * n[ii * 3 + 2];
            const d = Math.hypot(nx, ny, nz) || 1;
            b.nrm.push(...dirToLocal(w, [nx / d, ny / d, nz / d]));
          }
          if (hasUV) b.uv.push(uvArr[ii * 2], uvArr[ii * 2 + 1]);
        }
        b.idx.push(ni);
      }
    }
    // shrink the source primitive to the kept triangles (vertex buffers untouched);
    // dispose the replaced index accessor or it stays in the file as dead weight.
    // Whole-node prims skip this — their node is disposed below.
    if (srcOwner.has(p)) continue;
    if (keep.length !== p.idx.length) {
      const old = p.prim.getIndices();
      const acc = doc.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(p.pos.length / 3 > 65535 ? new Uint32Array(keep) : new Uint16Array(keep));
      p.prim.setIndices(acc);
      if (old && !old.listParents().some((par) => par.propertyType === "Primitive")) old.dispose();
    }
  }
  // 1:1 completeness gate — nothing tire-like may remain in the body below
  // the hub: a leftover ring there is exactly the "static tire around a
  // spinning disc" glitch. (Above the hub, fender lips legitimately overlap.)
  cutWheels.forEach((w, wi) => {
    if (w.srcPrims || w.belongs) return; // exact captures cannot leave tire behind
    let leftover = 0, moved = 0;
    for (const p of prims) {
      if (srcOwner.has(p)) continue;
      const idx = p.prim.getIndices() ? p.prim.getIndices().getArray() : null;
      const seen = new Set(idx ?? []);
      for (const ii of seen.size ? seen : []) {
        const sp = xform(p.matrix, p.pos[ii * 3], p.pos[ii * 3 + 1], p.pos[ii * 3 + 2]);
        const axle = w.axleAxis === 0 ? sp[0] : sp[2];
        const len = w.axleAxis === 0 ? sp[2] : sp[0];
        const axleHub = w.axleAxis === 0 ? w.hub[0] : w.hub[2];
        const lenHub = w.axleAxis === 0 ? w.hub[2] : w.hub[0];
        if (Math.abs(axle - axleHub) > w.halfWidth * 0.9) continue;
        if (sp[1] > w.hub[1] - w.radius * 0.1) continue; // below-hub zone only
        if (Math.hypot(sp[1] - w.hub[1], len - lenHub) < w.radius * 0.92) leftover++;
      }
    }
    for (const b of buckets[wi].values()) moved += b.pos.length / 3;
    if (!moved) throw new Error(`wheel_${wi}: cut produced no vertices`);
    if (leftover > moved * 0.02)
      throw new Error(`wheel_${wi}: ${leftover} body verts left inside the tire (moved ${moved}) — cut incomplete`);
  });
  // recenter each cut wheel on its CAPTURED geometry — fit error must not
  // become pivot wobble. Robust extents (0.5–99.5 percentile) so a stray
  // fender vert can't bias the hub; the measured half-extents replace the
  // fitted radius (1:1 with what actually spins).
  cutWheels.forEach((w, wi) => {
    const xs = [], ys = [], zs = [];
    for (const b of buckets[wi].values()) for (let i = 0; i < b.pos.length; i += 3) {
      xs.push(b.pos[i]); ys.push(b.pos[i + 1]); zs.push(b.pos[i + 2]);
    }
    if (!xs.length) return;
    const ext = (arr) => { arr.sort((a, b) => a - b); return [arr[Math.floor(arr.length * 0.005)], arr[Math.ceil(arr.length * 0.995) - 1]]; };
    const [x0, x1] = ext(xs), [y0] = ext(ys), [z0, z1] = ext(zs);
    // local +X = axle; rolling plane = local (y, z). The tire top may carry
    // captured fender-lip verts, but the BOTTOM is always clean (road side)
    // and the length extent is the pure circular diameter — so anchor the
    // center at bottom + diameter/2 instead of trusting the y midpoint.
    const d = z1 - z0;
    const cy = y0 + d / 2, cz = (z0 + z1) / 2;
    // Along the axle, pivot on the TREAD RING's center, not the assembly bbox
    // mid: deep-dish wheels (pink-rod's wire fronts) put the tread plane ~25%
    // of r off the rim+spokes middle, and steering must yaw about the contact
    // patch (the wheelqa steer-arm gate). Bbox mid stays the sparse fallback.
    const treadXs = [];
    for (const b of buckets[wi].values()) for (let i = 0; i < b.pos.length; i += 3) {
      if (Math.hypot(b.pos[i + 1] - cy, b.pos[i + 2] - cz) >= d * 0.425) treadXs.push(b.pos[i]); // 0.85·(d/2)
    }
    const [tx0, tx1] = treadXs.length >= 30 ? ext(treadXs) : [x0, x1];
    const cLoc = [(tx0 + tx1) / 2, cy, cz];
    for (const b of buckets[wi].values()) for (let i = 0; i < b.pos.length; i += 3) {
      b.pos[i] -= cLoc[0]; b.pos[i + 1] -= cLoc[1]; b.pos[i + 2] -= cLoc[2];
    }
    w.radius = d / 2;
    // move the node by the scene-space image of the local recenter offset
    const sceneOff = w.axleAxis === 0 ? cLoc : [cLoc[2], cLoc[1], -cLoc[0]];
    w.hub = [w.hub[0] + sceneOff[0], w.hub[1] + sceneOff[1], w.hub[2] + sceneOff[2]];
  });
  // build the wheel nodes (numbering continues after the tagged wheels —
  // tag and cut indices must not collide)
  cutWheels.forEach((w, cwi) => {
    const wi = wheels.indexOf(w);
    const mesh = doc.createMesh(`wheel_${wi}_mesh`);
    for (const [srcP, b] of buckets[cwi]) {
      const prim = doc.createPrimitive().setMode(4).setMaterial(srcP.prim.getMaterial());
      prim.setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array(b.pos)));
      if (b.nrm) prim.setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array(b.nrm)));
      if (b.uv) prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array(b.uv)));
      prim.setIndices(doc.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(b.pos.length / 3 > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx)));
      mesh.addPrimitive(prim);
    }
    if (!mesh.listPrimitives().length) throw new Error(`wheel_${wi}: cut produced no triangles`);
    const node = doc.createNode(`wheel_${wi}`)
      .setTranslation(w.hub)
      .setRotation(w.axleAxis === 2 ? YAW90 : [0, 0, 0, 1])
      .setMesh(mesh)
      .setExtras({ perpsWheel: { radius: w.radius, axle: [1, 0, 0], up: [0, 1, 0] } });
    scene.addChild(node);
    finalWheels.push({ node, hub: w.hub, radius: w.radius, axleAxis: w.axleAxis });
    // whole-node wheels: drop the emptied source subtree + its now-unused data
    // (meshes may live on CHILD nodes, e.g. flintstone's "..._wheel_0")
    if (w.srcNode) {
      const meshes = [];
      const collect = (nd) => { if (nd.getMesh()) meshes.push(nd.getMesh()); for (const c of nd.listChildren()) collect(c); };
      collect(w.srcNode);
      w.srcNode.dispose();
      for (const oldMesh of meshes) {
        if (oldMesh.listParents().some((par) => par.propertyType === "Node")) continue;
        const accs = [];
        for (const prim of oldMesh.listPrimitives()) {
          accs.push(prim.getIndices(), ...prim.listAttributes());
        }
        oldMesh.dispose();
        for (const a of accs) {
          if (a && !a.listParents().some((par) => par.propertyType === "Primitive")) a.dispose();
        }
      }
    }
  });
  return finalWheels;
}

// ---------- island detection (vaporwave) ----------
// Wheels are disjoint triangle islands inside a merged mesh: weld by position,
// union-find over triangles, shape-test each island. Capture is exact — a
// triangle belongs to a wheel iff its island root matches.
class UF {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x) { let r = x; while (this.p[r] !== r) r = this.p[r]; while (this.p[x] !== r) { const n = this.p[x]; this.p[x] = r; x = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}
function detectByIsland(prims, mn, mx) {
  const L = Math.max(mx[0] - mn[0], mx[2] - mn[2]), H = mx[1] - mn[1];
  let total = 0;
  for (const p of prims) total += p.pos.length / 3;
  const wpos = new Float64Array(total * 3);
  const baseOf = new Map();
  let o = 0;
  for (const p of prims) {
    baseOf.set(p, o);
    for (let i = 0; i < p.pos.length; i += 3) {
      const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
      wpos[o * 3] = w[0]; wpos[o * 3 + 1] = w[1]; wpos[o * 3 + 2] = w[2]; o++;
    }
  }
  const cell = L * 1e-5;
  const weld = new Map(); const wid = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const k = `${Math.round(wpos[i * 3] / cell)},${Math.round(wpos[i * 3 + 1] / cell)},${Math.round(wpos[i * 3 + 2] / cell)}`;
    let w = weld.get(k);
    if (w === undefined) { w = i; weld.set(k, w); }
    wid[i] = w;
  }
  const uf = new UF(total);
  for (const p of prims) {
    const b = baseOf.get(p);
    for (let t = 0; t < p.idx.length; t += 3) {
      uf.union(wid[b + p.idx[t]], wid[b + p.idx[t + 1]]);
      uf.union(wid[b + p.idx[t + 1]], wid[b + p.idx[t + 2]]);
    }
  }
  const comps = new Map();
  for (let i = 0; i < total; i++) {
    const r = uf.find(wid[i]);
    let c = comps.get(r);
    if (!c) { c = { n: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; comps.set(r, c); }
    c.n++;
    for (let k = 0; k < 3; k++) { const v = wpos[i * 3 + k]; if (v < c.mn[k]) c.mn[k] = v; if (v > c.mx[k]) c.mx[k] = v; }
  }
  const wheels = [];
  for (const [root, c] of comps) {
    if (c.n < 40) continue;
    const dx = c.mx[0] - c.mn[0], dy = c.mx[1] - c.mn[1], dz = c.mx[2] - c.mn[2];
    const rolling = Math.max(dx, dz), width = Math.min(dx, dz);
    if (Math.min(dy, rolling) / Math.max(dy, rolling) < 0.8) continue;
    if (width > 0.9 * dy) continue;
    if (dy < 0.04 * L || dy > 0.4 * L) continue;
    if (c.mn[1] - mn[1] > 0.12 * H) continue;
    wheels.push({
      hub: [(c.mn[0] + c.mx[0]) / 2, (c.mn[1] + c.mx[1]) / 2, (c.mn[2] + c.mx[2]) / 2],
      radius: dy / 2,
      axleAxis: dx < dz ? 0 : 2,
      halfWidth: width / 2,
      belongs: (p, ia) => uf.find(wid[baseOf.get(p) + ia]) === root,
    });
  }
  return wheels;
}

// ---------- manual detection (wheel-marker overrides) ----------
// Human-drawn circles from wheel-marker.html (scripts/wheel-overrides.json):
// each circle is a wheel outline in the side view — (length-coord, y, r) in
// scene units, covering BOTH mirrored wheels of an axle. Per side, the wheel's
// axle placement/width comes from the geometry inside the circle: the tire is
// the outermost dense band, so walk inward from the extreme until a sustained
// gap. Downstream (cut, recenter, harmonize) is the shared pipeline — the
// circle is a selector, the captured geometry remains the truth.
function detectByManual(spec, wv, mn, mx) {
  const axleAxis = spec.axle === "z" ? 2 : 0;
  const lengthAxis = axleAxis === 2 ? 0 : 2;
  const lenKey = axleAxis === 2 ? "x" : "z";
  const L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  const nv = wv.length / 3;
  const axleMid = (mn[axleAxis] + mx[axleAxis]) / 2;
  const wheels = [];
  spec.circles.forEach((c, ci) => {
    const cl = c[lenKey];
    if (!Number.isFinite(cl) || !Number.isFinite(c.y) || !(c.r > 0))
      throw new Error(`manual circle ${ci}: bad values ${JSON.stringify(c)}`);
    for (const side of [-1, 1]) {
      // explicit capture window along the axle (ac = center magnitude,
      // aw = half-width) — used when density derivation is unreliable
      // (pink-rod: front tires stick out at |z|≈0.53 while near-centerline
      // chassis verts chain through any gap rule). Hub z is the spin axis
      // itself so it has no visual effect; it only bounds the cut.
      if (Number.isFinite(c.ac) && Number.isFinite(c.aw)) {
        const hub = [0, c.y, 0];
        hub[lengthAxis] = cl;
        hub[axleAxis] = c.ac * side;
        wheels.push({ hub, radius: c.r, axleAxis, halfWidth: c.aw });
        continue;
      }
      // bottom sector of the circle only: the tire is the ONLY geometry at
      // the ground side; side pipes / running boards / chassis cross the
      // circle at hub height and would otherwise register as dense bands
      // (pink-rod's exhaust, six-wheeler's rocker) — measured, not assumed
      const coords = [];
      for (let i = 0; i < nv; i++) {
        if ((wv[i * 3 + axleAxis] - axleMid) * side <= 0) continue;
        if (wv[i * 3 + 1] >= c.y - 0.35 * c.r) continue;
        if (Math.hypot(wv[i * 3 + lengthAxis] - cl, wv[i * 3 + 1] - c.y) > c.r * 1.02) continue;
        coords.push(wv[i * 3 + axleAxis]);
      }
      if (coords.length < 30)
        throw new Error(`manual circle ${ci} side ${side}: only ${coords.length} verts inside — circle misses the tire?`);
      // The tire is the outermost DENSE band: its sidewall rings carry 10-50×
      // the vert density of any body/axle geometry crossing the circle region
      // (measured on clown-car: sidewalls ~5-7k verts/bin, body ≤500). Keep
      // bins ≥20% of the peak and take the outermost run of dense bins,
      // allowing gaps ≤ r between them (the sparse mid-tread dip between the
      // two sidewall rings). A plain walk-until-gap fails here — the axle
      // shaft connects the tire to the body with no gap at all.
      const binW = Math.max(c.r * 0.15, 1e-4);
      const hist = new Map();
      for (const a of coords) {
        const b = Math.round(a / binW);
        hist.set(b, (hist.get(b) ?? 0) + 1);
      }
      const peak = Math.max(...hist.values());
      const dense = [...hist.entries()].filter(([, n]) => n >= peak * 0.2).map(([b]) => b)
        .sort((p, q) => (q - p) * side); // outermost first
      let innerB = dense[0];
      for (let k = 1; k < dense.length; k++) {
        // sidewall rings can sit up to ~1.2r apart on wide duallies
        // (six-wheeler); crossers are already excluded by the bottom filter
        if (Math.abs(dense[k] - innerB) * binW > c.r * 1.6) break;
        innerB = dense[k];
      }
      const bLo = Math.min(dense[0], innerB) * binW - binW / 2;
      const bHi = Math.max(dense[0], innerB) * binW + binW / 2;
      const within = coords.filter((a) => a >= bLo && a <= bHi).sort((p, q) => p - q);
      const lo = within[Math.floor(within.length * 0.005)];
      const hi = within[Math.ceil(within.length * 0.995) - 1];
      const hub = [0, c.y, 0];
      hub[lengthAxis] = cl;
      hub[axleAxis] = (lo + hi) / 2;
      wheels.push({ hub, radius: c.r, axleAxis, halfWidth: Math.max((hi - lo) / 2, c.r * 0.15) });
    }
  });
  return wheels;
}

// cluster wheels by hub proximity: co-located nodes (tire+rim) = one wheel
function groupWheels(wheels) {
  const groups = [];
  for (const w of wheels) {
    const g = groups.find((g) => g.some((m) =>
      Math.hypot(m.hub[0] - w.hub[0], m.hub[1] - w.hub[1], m.hub[2] - w.hub[2]) < Math.max(m.radius, w.radius) * 0.5));
    if (g) g.push(w); else groups.push([w]);
  }
  return groups;
}

// ---------- per-model driver ----------
async function processModel(io, file, { dry, manual }) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  // rigging is a CUT — running it on an already-rigged model cuts the cut
  // (duplicate wheel_N nodes, hollow wheels). Only pristine input is valid;
  // fix-wheels.mjs restores it from the wheel-pristine.json blob first.
  if (doc.getRoot().listNodes().some((n) => /^wheel_\d+$/.test(n.getName())))
    throw new Error(`${name}: input is already rigged — restore the pristine GLB first (npm run wheels:fix -- ${name})`);
  const { prims, mn, mx } = gatherPrims(doc);
  const wheels = manual
    ? detectByManual(manual, worldVerts(prims), mn, mx)
    : NAMED_PATH.has(name)
      ? detectByName(doc, prims)
      : NODE_SHAPE_PATH.has(name)
        ? detectByNodeShape(prims, mn, mx)
        : ISLAND_PATH.has(name)
          ? detectByIsland(prims, mn, mx)
          : detectByGround(worldVerts(prims), mn, mx);
  if (!NAMED_PATH.has(name) && doc.getRoot().listSkins().length)
    throw new Error(`${name}: skinned mesh on the geometry path — unsupported`);
  const exp = EXPECTED[name];
  const L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  // a physical wheel may be several co-located nodes (cybertruck: tire+rim) —
  // count hub-proximity GROUPS against EXPECTED, rig every member
  const groups = groupWheels(wheels);
  console.log(`\n=== ${name}${manual ? " (manual override)" : ""}: ${groups.length} wheels / ${wheels.length} nodes (expected ${exp})`);
  for (const w of wheels)
    console.log(`  wheel hub=[${w.hub.map((v) => v.toFixed(2)).join(", ")}] r=${w.radius.toFixed(3)} (${(100 * w.radius / L).toFixed(1)}%L) axle=${w.axleAxis === 0 ? "X" : "Z"} halfW=${w.halfWidth.toFixed(3)}${w.tagNode ? ` tag:${w.tagNode.getName()}` : ""}`);
  if (groups.length !== exp) throw new Error(`${name}: found ${groups.length} wheels, expected ${exp}`);
  // sanity: one shared axle axis; group radii within a sane family ratio
  if (new Set(wheels.map((w) => w.axleAxis)).size !== 1) throw new Error(`${name}: mixed axle axes`);
  const rs = groups.map((g) => Math.max(...g.map((w) => w.radius)));
  if (Math.max(...rs) / Math.min(...rs) > 3.5) throw new Error(`${name}: radius spread too large`);
  // Steer-pivot slide for TAGGED wheels: an artist pivot off the tread center
  // ALONG THE AXLE makes a steered wheel swing sideways (wheelqa steer-arm
  // gate — delorean's inboard joints sat 29-36% of r off, cybertruck 10%).
  // Slide the pivot onto the group's tread center; geometry does not move
  // (joints get IBM compensation, mesh nodes a counter-shifted carrier).
  for (const g of groups) {
    const ref = g.reduce((a, b) => (b.radius > a.radius ? b : a));
    if (!ref.memberVerts) continue; // cut/extracted wheels recenter themselves
    const rollAxes = ref.axleAxis === 0 ? [1, 2] : [1, 0];
    const treadA = [];
    for (const v of ref.memberVerts) {
      const d = Math.hypot(v[rollAxes[0]] - ref.hub[rollAxes[0]], v[rollAxes[1]] - ref.hub[rollAxes[1]]);
      if (d >= ref.radius * 0.85 && d <= ref.radius * 1.15) treadA.push(v[ref.axleAxis]);
    }
    if (treadA.length < 30) continue;
    treadA.sort((a, b) => a - b);
    const qt = (f) => treadA[Math.min(treadA.length - 1, Math.floor(treadA.length * f))];
    const treadMid = (qt(0.01) + qt(0.99)) / 2;
    for (const w of g) {
      if (!w.tagNode || !w.pivot) continue;
      const delta = treadMid - w.pivot[w.axleAxis];
      if (Math.abs(delta) <= ref.radius * 0.025) continue;
      w.axleShift = delta;
      console.log(`  ${w.tagNode.getName()}: pivot ${(100 * delta / ref.radius).toFixed(1)}% of r off the tread center along the axle — sliding pivot`);
    }
  }
  if (!dry) {
    const finals = rigModel(doc, prims, wheels) ?? [];
    // Radius harmonization — wheels that turn together must be stamped with
    // ONE radius or they visibly spin out of sync:
    //   1. co-located nodes (tire+rim) take the group MAX (the tire defines
    //      the roll rate, not the smaller rim)
    //   2. mirrored wheels on one axle take the mean of their group radii
    const fGroups = groupWheels(finals);
    const lengthAxis = finals.length && finals[0].axleAxis === 0 ? 2 : 0;
    const reps = fGroups.map((g) => ({ g, r: Math.max(...g.map((w) => w.radius)), l: g[0].hub[lengthAxis] }));
    const axleClusters = [];
    for (const rep of reps) {
      const c = axleClusters.find((c) => Math.abs(c[0].l - rep.l) < Math.max(c[0].r, rep.r) * 0.6);
      if (c) c.push(rep); else axleClusters.push([rep]);
    }
    for (const cluster of axleClusters) {
      const rAxle = cluster.reduce((s, rep) => s + rep.r, 0) / cluster.length;
      for (const rep of cluster) for (const w of rep.g) {
        const ex = w.node.getExtras();
        w.node.setExtras({ ...ex, perpsWheel: { ...ex.perpsWheel, radius: rAxle } });
      }
    }
    await io.write(file, doc);
    console.log(`  rewrote ${file} (${axleClusters.map((c) => c[0] && (c.reduce((s, r) => s + r.r, 0) / c.length).toFixed(3)).join("/")} per-axle radii)`);
  }
  return wheels.length;
}

// ---------- verify mode ----------
async function verifyModel(io, file) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  const rigged = doc.getRoot().listNodes().filter((n) => /^wheel_\d+$/.test(n.getName()));
  const exp = EXPECTED[name];
  for (const n of rigged) {
    const pw = n.getExtras()?.perpsWheel;
    if (!(pw?.radius > 0) || pw.axle?.length !== 3 || pw.up?.length !== 3)
      throw new Error(`${name}/${n.getName()}: bad extras.perpsWheel ${JSON.stringify(pw)}`);
  }
  // group co-located nodes (tire+rim) the same way the rig counted them
  const asWheels = rigged.map((n) => {
    const wm = n.getWorldMatrix();
    return { hub: [wm[12], wm[13], wm[14]], radius: n.getExtras().perpsWheel.radius };
  });
  const groups = groupWheels(asWheels);
  if (groups.length !== exp) throw new Error(`${name}: ${groups.length} wheel groups (${rigged.length} nodes), expected ${exp}`);
  console.log(`OK ${name}: ${groups.length} wheels rigged (${rigged.length} nodes)`);
}

// ---------- main ----------
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const verify = args.includes("--verify");
const only = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
// human-drawn wheel circles (from wheel-marker.html) override auto-detection;
// loaded by default so a full re-rig reproduces the manual fixes
const manualPath = args.includes("--manual")
  ? args[args.indexOf("--manual") + 1]
  : resolve(dirname(fileURLToPath(import.meta.url)), "wheel-overrides.json");
const overrides = existsSync(manualPath) ? JSON.parse(readFileSync(manualPath, "utf8")) : {};
const io = new NodeIO();
const names = Object.keys(EXPECTED).filter((n) => !only || n === only);
for (const n of names) {
  const file = resolve(MODELS_DIR, `${n}.glb`);
  if (verify) await verifyModel(io, file);
  else await processModel(io, file, { dry, manual: overrides[n] ?? null });
}
console.log(`\n${verify ? "verify" : dry ? "dry-run" : "rig"} complete: ${names.length} models`);
