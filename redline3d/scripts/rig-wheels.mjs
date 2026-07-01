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

const MODELS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/models");

// Regression table — detection must find exactly this many wheels per model.
const EXPECTED = {
  "clown-car": 4, cybertruck: 4, delorean: 4, flintstone: 2, helmet: 4,
  orion: 4, "pink-rod": 4, "shopping-cart": 4, "six-wheeler": 6,
  skull: 4, "slot-machine": 4, starter: 4, vaporwave: 4,
};
// delorean/flintstone: welded-detection fails (0 / noisy clusters) but they
// have proper wheel nodes/joints — the named path handles them.
const NAMED_PATH = new Set(["delorean", "flintstone"]);
const WHEEL_NAME = /wheel|tire|tyre/i;
const NOT_WHEEL = /steering/i;

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
  // circle fit per hub, in the (lengthAxis, y) plane, slab along axleAxis
  const wheels = [];
  for (const h of hubs) {
    const ha = axleAxis === 0 ? h.x : h.z;   // hub coord along axle
    const hl = lengthAxis === 0 ? h.x : h.z; // hub coord along length
    let best = { score: -1 };
    for (let r = 0.008 * L; r <= 0.28 * L; r += 0.003 * L) {
      for (let dl = -0.03 * L; dl <= 0.03 * L; dl += 0.01 * L) {
        const y0 = mn[1] + r, l0 = hl + dl;
        let inl = 0, amn = 1e9, amx = -1e9;
        for (let i = 0; i < nv; i++) {
          const a = wv[i * 3 + axleAxis];
          if (Math.abs(a - ha) > Math.max(0.06 * L, r)) continue;
          const dy = wv[i * 3 + 1] - y0, dll = wv[i * 3 + lengthAxis] - l0;
          if (Math.abs(Math.hypot(dy, dll) - r) < 0.012 * L) {
            inl++; if (a < amn) amn = a; if (a > amx) amx = a;
          }
        }
        const score = inl / r;
        if (score > best.score) best = { score, r, l0, y0, inl, halfWidth: (amx - amn) / 2 };
      }
    }
    if (best.score <= 0 || best.inl < 60) continue;
    const hub = [0, best.y0, 0]; hub[axleAxis] = ha; hub[lengthAxis] = best.l0;
    wheels.push({ hub, radius: best.r, axleAxis, halfWidth: Math.max(best.halfWidth, best.r * 0.15), inliers: best.inl });
  }
  // merge overlapping candidates (shopping-cart double-detects its casters):
  // two hubs closer than ~the larger radius = the same wheel; keep the better fit
  wheels.sort((a, b) => b.inliers - a.inliers);
  const merged = [];
  for (const w of wheels) {
    if (merged.some((m) => Math.hypot(m.hub[0] - w.hub[0], m.hub[1] - w.hub[1], m.hub[2] - w.hub[2]) < Math.max(m.radius, w.radius) * 1.2)) continue;
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
  // plain-node members
  for (const p of prims) {
    if (!p.wheelRoot) continue;
    if (!roots.has(p.wheelRoot)) roots.set(p.wheelRoot, []);
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
    // the node must already pivot at the hub (it does for these models — they
    // steer today); gate rather than silently rig a wobbling wheel
    const off = Math.hypot(pivot[0] - center[0], pivot[1] - center[1], pivot[2] - center[2]);
    if (off > dy * 0.35) throw new Error(`${node.getName()}: pivot ${off.toFixed(2)} off hub (dy=${dy.toFixed(2)})`);
    wheels.push({ hub: center, radius: dy / 2, axleAxis, halfWidth: (axleAxis === 0 ? dx : dz) / 2, tagNode: node });
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
  // scene-space point -> wheel-local (undo hub translation, undo yaw)
  const toLocal = (w, p) => {
    const x = p[0] - w.hub[0], y = p[1] - w.hub[1], z = p[2] - w.hub[2];
    return w.axleAxis === 0 ? [x, y, z] : [z, y, -x]; // inverse of +90° yaw
  };
  const dirToLocal = (w, v) => (w.axleAxis === 0 ? v : [v[2], v[1], -v[0]]);

  // --- tag path ---
  wheels.forEach((w, wi) => {
    if (!w.tagNode) return;
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
  });
  const cutWheels = wheels.filter((w) => !w.tagNode);
  if (!cutWheels.length) return;

  // --- cut path ---
  // per-wheel accumulator: one new primitive per (wheel, source primitive)
  const buckets = cutWheels.map(() => new Map()); // srcPrim entry -> {pos,nrm,uv,idx,remap}
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
      let hit = -1;
      for (let wi = 0; wi < cutWheels.length; wi++) {
        const w = cutWheels[wi];
        const axle = w.axleAxis === 0 ? cx : cz;
        const len = w.axleAxis === 0 ? cz : cx;
        const axleHub = w.axleAxis === 0 ? w.hub[0] : w.hub[2];
        const lenHub = w.axleAxis === 0 ? w.hub[2] : w.hub[0];
        if (Math.abs(axle - axleHub) > w.halfWidth * 1.15 + w.radius * 0.02) continue;
        if (Math.hypot(cy - w.hub[1], len - lenHub) > w.radius * 1.08) continue;
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
    // dispose the replaced index accessor or it stays in the file as dead weight
    if (keep.length !== p.idx.length) {
      const old = p.prim.getIndices();
      const acc = doc.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(p.pos.length / 3 > 65535 ? new Uint32Array(keep) : new Uint16Array(keep));
      p.prim.setIndices(acc);
      if (old && !old.listParents().some((par) => par.propertyType === "Primitive")) old.dispose();
    }
  }
  // build the wheel nodes
  cutWheels.forEach((w, wi) => {
    const mesh = doc.createMesh(`wheel_${wi}_mesh`);
    for (const [srcP, b] of buckets[wi]) {
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
  });
}

// ---------- per-model driver ----------
async function processModel(io, file, { dry }) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  const { prims, mn, mx } = gatherPrims(doc);
  const wheels = NAMED_PATH.has(name)
    ? detectByName(doc, prims)
    : detectByGround(worldVerts(prims), mn, mx);
  if (!NAMED_PATH.has(name) && doc.getRoot().listSkins().length)
    throw new Error(`${name}: skinned mesh on the geometry path — unsupported`);
  const exp = EXPECTED[name];
  const L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  console.log(`\n=== ${name}: ${wheels.length} wheels (expected ${exp})`);
  for (const w of wheels)
    console.log(`  wheel hub=[${w.hub.map((v) => v.toFixed(2)).join(", ")}] r=${w.radius.toFixed(3)} (${(100 * w.radius / L).toFixed(1)}%L) axle=${w.axleAxis === 0 ? "X" : "Z"} halfW=${w.halfWidth.toFixed(3)}${w.tagNode ? ` tag:${w.tagNode.getName()}` : ""}`);
  if (wheels.length !== exp) throw new Error(`${name}: found ${wheels.length} wheels, expected ${exp}`);
  // sanity: one shared axle axis; radii within a sane family ratio
  if (new Set(wheels.map((w) => w.axleAxis)).size !== 1) throw new Error(`${name}: mixed axle axes`);
  const rs = wheels.map((w) => w.radius);
  if (Math.max(...rs) / Math.min(...rs) > 3.5) throw new Error(`${name}: radius spread too large`);
  if (!dry) {
    rigModel(doc, prims, wheels);
    await io.write(file, doc);
    console.log(`  rewrote ${file}`);
  }
  return wheels.length;
}

// ---------- verify mode ----------
async function verifyModel(io, file) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  const rigged = doc.getRoot().listNodes().filter((n) => /^wheel_\d+$/.test(n.getName()));
  const exp = EXPECTED[name];
  if (rigged.length !== exp) throw new Error(`${name}: ${rigged.length} wheel_N nodes, expected ${exp}`);
  for (const n of rigged) {
    const pw = n.getExtras()?.perpsWheel;
    if (!(pw?.radius > 0) || pw.axle?.length !== 3 || pw.up?.length !== 3)
      throw new Error(`${name}/${n.getName()}: bad extras.perpsWheel ${JSON.stringify(pw)}`);
  }
  console.log(`OK ${name}: ${rigged.length} wheels rigged`);
}

// ---------- main ----------
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const verify = args.includes("--verify");
const only = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
const io = new NodeIO();
const names = Object.keys(EXPECTED).filter((n) => !only || n === only);
for (const n of names) {
  const file = resolve(MODELS_DIR, `${n}.glb`);
  if (verify) await verifyModel(io, file);
  else await processModel(io, file, { dry });
}
console.log(`\n${verify ? "verify" : dry ? "dry-run" : "rig"} complete: ${names.length} models`);
