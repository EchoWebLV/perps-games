# Wheel Animation Auto-Rig Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every one of the 13 car GLBs gets spinning wheels (rolling at `speed / radius`) and geometric front-wheel steering, via a one-time offline auto-rig script plus a small runtime spinner.

**Architecture:** An offline Node script (`scripts/rig-wheels.mjs`, using `@gltf-transform/core`) detects wheels in each GLB — by ground-contact clustering + circle fit for welded single-mesh models, by named nodes for delorean/flintstone — and rewrites each GLB so every wheel is its own node named `wheel_N`, pivot at the hub, **local +X = axle**, with `extras.perpsWheel = { radius }`. The runtime (`src/render/wheels.ts`, wired into `src/render/car.ts`) collects those nodes from `userData`, classifies the front axle geometrically, and each frame applies `rotation.set(spin, steer, 0, 'YXZ')`.

**Tech Stack:** Node ESM script, `@gltf-transform/core` (new devDependency), Three.js GLTFLoader (already used), Vitest (already configured).

**Design doc:** `docs/2026-07-01-wheel-animation-auto-rig-design.md`. Proven prototypes (detection validated against all 13 real GLBs on 2026-07-01) live in the session scratchpad `wheel-detect.mjs` / `wheel-detect2.mjs`; the script below is the production port with the three known fixes: correct rolling plane per model (length-axis inference), lower radius search floor (starter), overlapping-candidate merge (shopping-cart).

**Working state:** branch `onchain-er-rebuild`, everything local. All commands run from `redline3d/`.

**Facts the engineer must not re-derive** (verified against the real GLBs):

- None of the 13 GLBs are Draco-compressed; all geometry is plain float32.
- 8 models are single welded meshes (wheels share vertices with the body): clown-car, skull, pink-rod, six-wheeler, shopping-cart, slot-machine, starter, helmet. Topological splitting fails on them.
- Wheels are the only geometry touching the ground. Bottom-2.5%-of-height vertex clustering finds every wheel: 4 for most, **6 for six-wheeler**, 2 full-width stone **rollers** for flintstone.
- delorean's ground-contact detection finds 0 clusters (odd wrapper transforms); it has named nodes `Wheel_Front_L_02`, `Wheel_Rear_L_04`, `Wheel_Front_R_09`, `Wheel_Rear_R_011`. flintstone's contact clustering is noisy (rollers span the car width); it has named nodes `flinstone car wheel front`, `flinstone car wheel back` **plus a `flinstone car steering wheel` node that must be excluded**.
- Model "length axis" varies: carpicker yaws (`src/main.ts:197-213`) put length on X for clown-car/skull/slot-machine/shopping-cart/helmet/pink-rod/six-wheeler/starter (yaw π/2) and orion (−π/2); on Z for delorean/cybertruck/vaporwave/flintstone. The script infers this from hub spread (length axis = horizontal axis with the larger hub spread) — validated against all models with ≥4 wheels.
- Runtime: the model is yawed by `MODEL_YAW + yawAdd` inside the car group, and the car nose faces **−Z in car space**. Road speed in race mode and `drive.speed` in the lobby are both world-units/sec — exactly the wheels' rolling speed.

---

## File Structure

- Create: `redline3d/scripts/rig-wheels.mjs` — offline detector + rigger (report, cut, write, verify).
- Create: `redline3d/src/render/wheels.ts` — runtime wheel rig: pure helpers (exported for tests) + `buildWheelRig()`.
- Create: `redline3d/src/render/wheels.test.ts` — vitest for the pure helpers.
- Modify: `redline3d/src/render/car.ts` — replace the `frontWheels` regex steering with the rig; `update(dt)` → `update(dt, speed)`.
- Modify: `redline3d/src/main.ts` — pass speed at the two `car.update` call sites (lines 518 and 632).
- Modify (binary, by script): `redline3d/public/models/*.glb` — rewritten with wheel nodes.
- Modify: `redline3d/package.json` — devDependency + `rig:wheels` script.

---

### Task 1: Rig script — detection core + dry-run report

**Files:**
- Create: `redline3d/scripts/rig-wheels.mjs`
- Modify: `redline3d/package.json`

- [ ] **Step 1.1: Install the GLB toolkit**

```bash
cd redline3d && npm i -D @gltf-transform/core
```

Expected: adds `@gltf-transform/core` (v4.x) to devDependencies.

- [ ] **Step 1.2: Add the npm script**

In `redline3d/package.json` `"scripts"`, after `"bake:cards"`:

```json
"rig:wheels": "node scripts/rig-wheels.mjs",
```

- [ ] **Step 1.3: Create `scripts/rig-wheels.mjs` with the detection core**

The whole file for this task (cutting is Task 2 — `rigModel` is a stub that only reports):

```js
// rig-wheels.mjs — one-time wheel auto-rig for all car GLBs.
// Detects wheels (ground-contact clustering + circle fit, or named nodes),
// extracts each into its own `wheel_N` node (pivot at hub, local +X = axle,
// extras.perpsWheel = { radius }), and rewrites the GLB in place.
//
//   node scripts/rig-wheels.mjs --dry            # detect + report only
//   node scripts/rig-wheels.mjs                  # rig + overwrite all models
//   node scripts/rig-wheels.mjs --model skull    # one model
//   node scripts/rig-wheels.mjs --verify         # re-open outputs, assert rigged
import { NodeIO } from "@gltf-transform/core";
import { resolve, basename } from "path";

const MODELS_DIR = resolve(import.meta.dirname, "../public/models");

// Regression table — detection must find exactly this many wheels per model.
const EXPECTED = {
  "clown-car": 4, cybertruck: 4, delorean: 4, flintstone: 2, helmet: 4,
  orion: 4, "pink-rod": 4, "shopping-cart": 4, "six-wheeler": 6,
  skull: 4, "slot-machine": 4, starter: 4, vaporwave: 4,
};
// delorean/flintstone: welded-detection fails (0 / noisy clusters) but they
// have proper wheel nodes — the named path handles them.
const NAMED_PATH = new Set(["delorean", "flintstone"]);
const WHEEL_NAME = /wheel|tire|tyre/i;
const NOT_WHEEL = /steering/i;

// ---------- linear algebra helpers (column-major mat4, like glTF) ----------
const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
// normal transform: inverse-transpose of the 3x3, then normalize on use
function normalMat3(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [A / det, B / det, C / det,
          (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det,
          (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det];
}

// ---------- gather the triangle soup (scene space) ----------
// Returns { prims, bbox } where each prim entry keeps enough to cut later:
// { prim, matrix, nmat, pos (local Float32Array), idx (Uint32Array), node }
function gatherPrims(doc) {
  const prims = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // TRIANGLES only
        const pos = prim.getAttribute("POSITION").getArray();
        const idxAcc = prim.getIndices();
        let idx;
        if (idxAcc) idx = Uint32Array.from(idxAcc.getArray());
        else { idx = new Uint32Array(pos.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i; }
        prims.push({ prim, node, matrix: m, nmat: normalMat3(m), pos, idx });
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const n of scene.listChildren()) visit(n);
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
    for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
  }
  return { prims, mn, mx };
}

// world-space vertex iterator (flat array [x,y,z,...]) — built once, reused
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
// Returns [{ hub:[x,y,z], radius, axleAxis: 0|2, halfWidth }]
function detectByGround(wv, mn, mx) {
  const H = mx[1] - mn[1], L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  const nv = wv.length / 3;
  // 1) contact clusters (bottom 2.5% of height), greedy in XZ
  const clusters = [];
  for (let i = 0; i < nv; i++) {
    if (wv[i * 3 + 1] > mn[1] + 0.025 * H) continue;
    const x = wv[i * 3], z = wv[i * 3 + 2];
    let c = clusters.find((c) => Math.hypot(c.sx / c.n - x, c.sz / c.n - z) < 0.09 * L);
    if (c) { c.sx += x; c.sz += z; c.n++; } else clusters.push({ sx: x, sz: z, n: 1 });
  }
  const hubs = clusters.filter((c) => c.n >= 8).map((c) => ({ x: c.sx / c.n, z: c.sz / c.n }));
  if (hubs.length < 2) return [];
  // 2) length axis = horizontal axis with larger hub spread; axle = the other
  const spread = (k) => Math.max(...hubs.map((h) => h[k])) - Math.min(...hubs.map((h) => h[k]));
  const lengthAxis = spread("x") >= spread("z") ? 0 : 2; // 0=x, 2=z
  const axleAxis = lengthAxis === 0 ? 2 : 0;
  // 3) circle fit per hub, in the (lengthAxis, y) plane, slab along axleAxis.
  //    Floor 0.008L (starter's real radius sat below the prototype's 0.02L floor).
  const wheels = [];
  for (const h of hubs) {
    const ha = axleAxis === 0 ? h.x : h.z;          // hub coord along axle
    const hl = lengthAxis === 0 ? h.x : h.z;        // hub coord along length
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
  // 4) merge overlapping candidates (shopping-cart double-detects its casters):
  //    two hubs closer than the larger radius = the same wheel; keep the better fit.
  wheels.sort((a, b) => b.inliers - a.inliers);
  const merged = [];
  for (const w of wheels) {
    if (merged.some((m) => Math.hypot(m.hub[0] - w.hub[0], m.hub[1] - w.hub[1], m.hub[2] - w.hub[2]) < Math.max(m.radius, w.radius) * 1.2)) continue;
    merged.push(w);
  }
  return merged;
}

// ---------- named-path detection (delorean, flintstone) ----------
// A wheel region = all primitives under a wheel-named node (parents win:
// flintstone nests "... wheel front" -> "..._wheel_0"). Hub/radius from the
// region's scene-space bbox: radius = dy/2; axle = the horizontal dim that
// does NOT match dy (a wheel is circular in the (length, y) profile).
function detectByName(doc, prims) {
  const owners = new Map(); // wheelRootNode -> prim entries
  for (const p of prims) {
    let n = p.node, root = null;
    while (n) {
      if (WHEEL_NAME.test(n.getName() || "") && !NOT_WHEEL.test(n.getName() || "")) root = n;
      n = n.getParentNode ? n.getParentNode() : null;
    }
    if (root) { if (!owners.has(root)) owners.set(root, []); owners.get(root).push(p); }
  }
  const wheels = [];
  for (const [node, list] of owners) {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const p of list) for (let i = 0; i < p.pos.length; i += 3) {
      const w = xform(p.matrix, p.pos[i], p.pos[i + 1], p.pos[i + 2]);
      for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    }
    const dx = mx[0] - mn[0], dy = mx[1] - mn[1], dz = mx[2] - mn[2];
    const axleAxis = Math.abs(dx - dy) > Math.abs(dz - dy) ? 0 : 2; // dim farther from dy
    const hub = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    wheels.push({ hub, radius: dy / 2, axleAxis, halfWidth: (axleAxis === 0 ? dx : dz) / 2, srcNode: node, srcPrims: list });
  }
  return wheels;
}

// ---------- per-model driver ----------
async function processModel(io, file, { dry }) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  if (doc.getRoot().listSkins().length) throw new Error(`${name}: skinned mesh — unsupported`);
  const { prims, mn, mx } = gatherPrims(doc);
  const wheels = NAMED_PATH.has(name)
    ? detectByName(doc, prims)
    : detectByGround(worldVerts(prims), mn, mx);
  const exp = EXPECTED[name];
  const L = Math.max(mx[0] - mn[0], mx[2] - mn[2]);
  console.log(`\n=== ${name}: ${wheels.length} wheels (expected ${exp})`);
  for (const w of wheels)
    console.log(`  🛞 hub=[${w.hub.map((v) => v.toFixed(2)).join(", ")}] r=${w.radius.toFixed(3)} (${(100 * w.radius / L).toFixed(1)}%L) axle=${w.axleAxis === 0 ? "X" : "Z"} halfW=${w.halfWidth.toFixed(3)}`);
  if (wheels.length !== exp) throw new Error(`${name}: found ${wheels.length} wheels, expected ${exp}`);
  // sanity: all wheels share one axle axis; radii within a sane family ratio
  if (new Set(wheels.map((w) => w.axleAxis)).size !== 1) throw new Error(`${name}: mixed axle axes`);
  const rs = wheels.map((w) => w.radius);
  if (Math.max(...rs) / Math.min(...rs) > 3.5) throw new Error(`${name}: radius spread too large`);
  if (!dry) {
    rigModel(doc, prims, wheels);         // Task 2
    await io.write(file, doc);
    console.log(`  ✍️  rewrote ${file}`);
  }
  return wheels.length;
}

function rigModel() { throw new Error("rigModel: implemented in Task 2"); } // placeholder

// ---------- verify mode (Task 2 fills the assertions' target data) ----------
async function verifyModel(io, file) {
  const name = basename(file, ".glb");
  const doc = await io.read(file);
  const rigged = doc.getRoot().listNodes().filter((n) => /^wheel_\d+$/.test(n.getName()));
  const exp = EXPECTED[name];
  if (rigged.length !== exp) throw new Error(`${name}: ${rigged.length} wheel_N nodes, expected ${exp}`);
  for (const n of rigged) {
    const r = n.getExtras()?.perpsWheel?.radius;
    if (!(r > 0)) throw new Error(`${name}/${n.getName()}: missing extras.perpsWheel.radius`);
    if (!n.getMesh()) throw new Error(`${name}/${n.getName()}: no mesh`);
  }
  console.log(`✅ ${name}: ${rigged.length} wheels rigged`);
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
```

- [ ] **Step 1.4: Dry-run all models and tune until green**

```bash
cd redline3d && node scripts/rig-wheels.mjs --dry
```

Expected: every model prints its wheel table and `dry-run complete: 13 models` — meaning detection matched `EXPECTED` for all (clown-car 4, six-wheeler 6, flintstone 2 rollers, delorean 4 via names, etc.).

If a model misses: the knobs, in order of likelihood — contact cluster merge distance (`0.09 * L`), min cluster verts (`>= 8`), radius floor (`0.008 * L`), inlier threshold (`inl < 60`), merge distance (`* 1.2`). The prototype already validated the approach; only thresholds may need nudging. Do NOT special-case a model by name (other than the `NAMED_PATH` set) — that defeats the design.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/rig-wheels.mjs package.json package-lock.json
git commit -m "feat(client): wheel auto-rig script — detection core, dry-run green on all 13 models"
```

---

### Task 2: Rig script — cut, re-node, write, verify

**Files:**
- Modify: `redline3d/scripts/rig-wheels.mjs` (replace the `rigModel` placeholder)

- [ ] **Step 2.1: Replace the `rigModel` placeholder with the real implementation**

```js
// ---------- rigging: extract each wheel into its own node ----------
// Convention: node `wheel_N`, translation = hub (scene space), rotation such
// that LOCAL +X = axle (identity when axleAxis===0, +90° yaw when axleAxis===2),
// geometry rebased into that frame, extras.perpsWheel = { radius }.
// Cut rule: a triangle belongs to a wheel when its scene-space centroid is
// inside the wheel cylinder: |along axle - hub| < halfWidth*1.15 + 2% r,
// and radial distance in the rolling plane < radius*1.08.
function rigModel(doc, prims, wheels) {
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  // 90° yaw quaternion maps local +X to scene +Z (for axleAxis===2 wheels)
  const YAW90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  // scene-space point -> wheel-local (undo hub translation, undo yaw)
  const toLocal = (w, p) => {
    const x = p[0] - w.hub[0], y = p[1] - w.hub[1], z = p[2] - w.hub[2];
    return w.axleAxis === 0 ? [x, y, z] : [z, y, -x]; // inverse of +90° yaw
  };
  const dirToLocal = (w, v) => (w.axleAxis === 0 ? v : [v[2], v[1], -v[0]]);

  // per-wheel accumulator: one new primitive per (wheel, source-primitive)
  const buckets = wheels.map(() => new Map()); // prim -> {pos:[],nrm:[],uv:[],idx:[],remap:Map}
  for (const p of prims) {
    const keep = [];
    const hasN = !!p.prim.getAttribute("NORMAL");
    const hasUV = !!p.prim.getAttribute("TEXCOORD_0");
    const nrmArr = hasN ? p.prim.getAttribute("NORMAL").getArray() : null;
    const uvArr = hasUV ? p.prim.getAttribute("TEXCOORD_0").getArray() : null;
    for (let t = 0; t < p.idx.length; t += 3) {
      const ia = p.idx[t], ib = p.idx[t + 1], ic = p.idx[t + 2];
      // scene-space centroid
      let cx = 0, cy = 0, cz = 0;
      for (const ii of [ia, ib, ic]) {
        const w = xform(p.matrix, p.pos[ii * 3], p.pos[ii * 3 + 1], p.pos[ii * 3 + 2]);
        cx += w[0] / 3; cy += w[1] / 3; cz += w[2] / 3;
      }
      let hit = -1;
      for (let wi = 0; wi < wheels.length; wi++) {
        const w = wheels[wi];
        if (w.srcPrims && !w.srcPrims.includes(p)) continue;      // named path: only its own prims
        if (w.srcPrims) { hit = wi; break; }                       // named path: take every triangle
        const axle = w.axleAxis === 0 ? cx : cz;
        const len = w.axleAxis === 0 ? cz : cx;
        const lenHub = w.axleAxis === 0 ? w.hub[2] : w.hub[0];
        if (Math.abs(axle - (w.axleAxis === 0 ? w.hub[0] : w.hub[2])) > w.halfWidth * 1.15 + w.radius * 0.02) continue;
        if (Math.hypot(cy - w.hub[1], len - lenHub) > w.radius * 1.08) continue;
        hit = wi; break;
      }
      if (hit < 0) { keep.push(ia, ib, ic); continue; }
      // move this triangle into the wheel bucket (rebased into wheel-local frame)
      const w = wheels[hit];
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
            let nx = m[0] * n[ii * 3] + m[3] * n[ii * 3 + 1] + m[6] * n[ii * 3 + 2];
            let ny = m[1] * n[ii * 3] + m[4] * n[ii * 3 + 1] + m[7] * n[ii * 3 + 2];
            let nz = m[2] * n[ii * 3] + m[5] * n[ii * 3 + 1] + m[8] * n[ii * 3 + 2];
            const d = Math.hypot(nx, ny, nz) || 1;
            b.nrm.push(...dirToLocal(w, [nx / d, ny / d, nz / d]));
          }
          if (hasUV) b.uv.push(uvArr[ii * 2], uvArr[ii * 2 + 1]);
        }
        b.idx.push(ni);
      }
    }
    // shrink the source primitive to the kept triangles (vertex buffers untouched)
    if (keep.length !== p.idx.length) {
      const acc = doc.createAccessor().setType("SCALAR").setBuffer(buffer)
        .setArray(p.pos.length / 3 > 65535 ? new Uint32Array(keep) : new Uint16Array(keep));
      p.prim.setIndices(acc);
    }
  }
  // build the wheel nodes
  wheels.forEach((w, wi) => {
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
      .setExtras({ perpsWheel: { radius: w.radius } });
    scene.addChild(node);
    // named path: drop the old wheel node (its geometry now lives in wheel_N)
    if (w.srcNode) w.srcNode.dispose();
  });
}
```

Note the named-path subtlety: `detectByName` stores `srcPrims`/`srcNode` on the wheel; the cut loop takes *every* triangle of those primitives (no cylinder test) and the old node is disposed after extraction.

- [ ] **Step 2.2: Rig one model and verify structurally**

```bash
cd redline3d && node scripts/rig-wheels.mjs --model clown-car && node scripts/rig-wheels.mjs --verify --model clown-car
```

Expected: `✍️ rewrote .../clown-car.glb` then `✅ clown-car: 4 wheels rigged`.

```bash
git diff --stat public/models/clown-car.glb   # confirms the binary changed
```

- [ ] **Step 2.3: Spot-check the cut visually before running the fleet**

Load the rewritten clown-car in the browser (Task 6 machinery isn't built yet, so quick and dirty): `preview_start` the vite dev server, open the game, screenshot. The clown car is the boot-adjacent model — pick it in the garage if needed. Look for: wheels present, no holes in the body at the wheel wells, no fender chunk missing.

If the cut is too greedy/timid, tune the two factors in the cut rule (`halfWidth * 1.15`, `radius * 1.08`) and re-run (re-runs are idempotent only via git — `git checkout -- public/models/clown-car.glb` first, then rig again).

- [ ] **Step 2.4: Commit the script**

```bash
git add scripts/rig-wheels.mjs
git commit -m "feat(client): wheel auto-rig script — cylinder cut, wheel_N nodes, extras, verify mode"
```

---

### Task 3: Rig all 13 models

**Files:**
- Modify: `redline3d/public/models/*.glb` (all 13, binary)

- [ ] **Step 3.1: Restore any spot-check model, then rig the fleet**

```bash
cd redline3d
git checkout -- public/models/   # clean slate so every model rigs from the original
node scripts/rig-wheels.mjs      # all 13
node scripts/rig-wheels.mjs --verify
```

Expected: 13 × `✍️ rewrote`, then 13 × `✅ ... wheels rigged`, no thrown gates.

- [ ] **Step 3.2: Sanity-check sizes**

```bash
ls -la public/models/*.glb
```

Expected: each file within a few percent of its original size (same triangles, a few extra nodes/accessors). A file that ballooned or shrank dramatically means the cut or write went wrong — stop and investigate.

- [ ] **Step 3.3: Commit the rigged models**

```bash
git add public/models
git commit -m "chore(models): auto-rig wheels into wheel_N nodes on all 13 car GLBs"
```

---

### Task 4: Runtime wheel rig (`wheels.ts`) — TDD

**Files:**
- Create: `redline3d/src/render/wheels.ts`
- Create: `redline3d/src/render/wheels.test.ts`

- [ ] **Step 4.1: Write the failing tests**

`src/render/wheels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { pickFrontWheels, spinSign, collectWheels } from "./wheels";

const wheelAt = (x: number, z: number, radius = 1) => {
  const o = new THREE.Object3D();
  o.name = "wheel_0";
  o.userData.perpsWheel = { radius };
  o.position.set(x, 0.5, z);
  return o;
};

describe("pickFrontWheels", () => {
  it("picks the min-z axle pair (car nose faces -Z)", () => {
    const wheels = [wheelAt(-1, -2), wheelAt(1, -2), wheelAt(-1, 2), wheelAt(1, 2)];
    expect(pickFrontWheels(wheels)).toEqual([wheels[0], wheels[1]]);
  });
  it("six wheels: only the frontmost axle steers", () => {
    const wheels = [wheelAt(-1, -2), wheelAt(1, -2), wheelAt(-1, 0), wheelAt(1, 0), wheelAt(-1, 2), wheelAt(1, 2)];
    expect(pickFrontWheels(wheels)).toEqual([wheels[0], wheels[1]]);
  });
  it("clusters axles with tolerance (slightly staggered hubs)", () => {
    const wheels = [wheelAt(-1, -2.05), wheelAt(1, -1.95), wheelAt(-1, 2), wheelAt(1, 2)];
    expect(pickFrontWheels(wheels)).toHaveLength(2);
  });
});

describe("spinSign", () => {
  it("is -1 when local +X points at world +X (forward = negative spin)", () => {
    const o = new THREE.Object3D();
    o.updateMatrixWorld(true);
    expect(spinSign(o)).toBe(-1);
  });
  it("flips when the wheel node is yawed 180°", () => {
    const parent = new THREE.Object3D();
    const o = new THREE.Object3D();
    parent.add(o);
    parent.rotation.y = Math.PI;
    parent.updateMatrixWorld(true);
    expect(spinSign(o)).toBe(1);
  });
});

describe("collectWheels", () => {
  it("finds nodes carrying userData.perpsWheel anywhere in the tree", () => {
    const root = new THREE.Group();
    const mid = new THREE.Group();
    root.add(mid);
    const w = wheelAt(0, 0, 0.3);
    mid.add(w);
    expect(collectWheels(root)).toEqual([w]);
  });
});
```

- [ ] **Step 4.2: Run and watch them fail**

```bash
cd redline3d && npx vitest run src/render/wheels.test.ts
```

Expected: FAIL — `Cannot find module './wheels'`.

- [ ] **Step 4.3: Implement `src/render/wheels.ts`**

```ts
import * as THREE from "three";

/**
 * Runtime wheel rig. The offline rig script (scripts/rig-wheels.mjs) rewrote
 * every car GLB so each wheel is a node with userData.perpsWheel = { radius }
 * (radius in model units), pivot at the hub, local +X = axle. Here we collect
 * those nodes, pick the front axle geometrically (car nose faces -Z in car
 * space), and drive rotation.set(spin, steer, 0, 'YXZ') every frame.
 */
export interface WheelRig {
  /** advance wheel roll; speed in world units/sec (road speed or lobby drive speed) */
  spin(dt: number, speed: number): void;
  /** steer the front axle, in radians (already clamped by the caller) */
  steer(angle: number): void;
}

export function collectWheels(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.userData?.perpsWheel?.radius > 0) out.push(o); });
  return out;
}

/** front axle = wheels sharing the smallest z (car nose faces -Z); positions
 *  must be up to date in car space (call model.updateMatrixWorld(true) first) */
export function pickFrontWheels(wheels: THREE.Object3D[]): THREE.Object3D[] {
  if (wheels.length < 3) return wheels; // 2 rollers: both "steer" is wrong — but rollers don't steer; caller guards
  const pos = wheels.map((w) => new THREE.Vector3().setFromMatrixPosition(w.matrixWorld));
  const zs = pos.map((p) => p.z);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const tol = Math.max((maxZ - minZ) * 0.25, 1e-6);
  return wheels.filter((_, i) => zs[i] - minZ < tol);
}

/** sign so that positive forward speed rolls the wheel forward: a wheel whose
 *  local +X maps to world +X must spin negatively (right-hand rule, nose -Z) */
export function spinSign(wheel: THREE.Object3D): -1 | 1 {
  const lx = new THREE.Vector3(1, 0, 0).transformDirection(wheel.matrixWorld);
  return lx.x >= 0 ? -1 : 1;
}

export function buildWheelRig(model: THREE.Object3D, worldScale: number): WheelRig | null {
  model.updateMatrixWorld(true);
  const wheels = collectWheels(model);
  if (!wheels.length) return null;
  const fronts = new Set(wheels.length >= 3 ? pickFrontWheels(wheels) : []);
  const per = wheels.map((w) => ({
    o: w,
    radius: (w.userData.perpsWheel.radius as number) * worldScale,
    sign: spinSign(w),
    front: fronts.has(w),
  }));
  for (const p of per) p.o.rotation.order = "YXZ";
  let spinAngle = 0;
  let steerAngle = 0;
  return {
    spin(dt, speed) {
      spinAngle += dt * speed; // radius applied per-wheel below (radii differ per axle)
      for (const p of per) {
        p.o.rotation.x = (p.sign * spinAngle) / p.radius;
        p.o.rotation.y = p.front ? steerAngle : 0;
      }
    },
    steer(angle) {
      steerAngle = angle;
    },
  };
}
```

- [ ] **Step 4.4: Run the tests to green**

```bash
cd redline3d && npx vitest run src/render/wheels.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 4.5: Commit**

```bash
git add src/render/wheels.ts src/render/wheels.test.ts
git commit -m "feat(client): runtime wheel rig — spin + geometric front-axle steer (TDD)"
```

---

### Task 5: Wire into `car.ts` and `main.ts`

**Files:**
- Modify: `redline3d/src/render/car.ts`
- Modify: `redline3d/src/main.ts:518` and `:632`

- [ ] **Step 5.1: Replace the regex wheel steering in `car.ts` with the rig**

In `src/render/car.ts`:

1. Add the import at the top (after the GLTFLoader import):

```ts
import { buildWheelRig, type WheelRig } from "./wheels";
```

2. Update the interface doc + `update` signature (replace the existing `update` and `setSteer` lines in `export interface Car`):

```ts
  /** advance animations; speed = world units/sec (road speed / lobby drive speed) */
  update(dt: number, speed?: number): void;
```

(`setSteer` stays as-is.)

3. Replace the `frontWheels` state (line ~104):

```ts
  let rig: WheelRig | null = null;
```

4. In `loadModel`'s success callback, delete the wheel-collection line inside `model.traverse` (the `if (/wheel.*front/i.test(o.name)) wheels.push(...)` line and the `const wheels: ... = []` declaration), and after `group.add(model);` replace `frontWheels = wheels;` with:

```ts
        rig = buildWheelRig(model, model.scale.x);
```

(`model.scale.x` is the uniform normalization scalar set a few lines above — it converts the rig's model-unit radii to world units.)

5. Replace the returned `update` and `setSteer`:

```ts
    update(dt, speed = 0) {
      t += dt;
      glow.intensity = 2 + Math.sin(t * 3) * 0.5; // faint underglow breathing
      rig?.spin(dt, speed);
    },
    setSteer(angle) {
      const a = Math.max(-1, Math.min(1, angle)) * MAX_STEER;
      rig?.steer(a);
    },
```

- [ ] **Step 5.2: Pass speed at both call sites in `main.ts`**

Lobby (line 518): `car.update(dt);` → `car.update(dt, drive.speed);`

Race (line 632): `car.update(dt);` → `car.update(dt, speed);`
(`speed` is defined 6 lines above at line 626 — already in scope.)

- [ ] **Step 5.3: Typecheck + full test suite**

```bash
cd redline3d && npx tsc --noEmit && npm test
```

Expected: clean tsc, all vitest suites pass (including the pre-existing ones — `carpicker.test.ts`, `freedrive.test.ts`, `wallet.test.ts` etc. don't touch the car render module, but run everything anyway).

- [ ] **Step 5.4: Commit**

```bash
git add src/render/car.ts src/main.ts
git commit -m "feat(client): spin all wheels off road speed; steer front axle geometrically"
```

---

### Task 6: Browser verification — all 13 cars

Per project rule (verify-ui-in-browser-before-done): tsc/tests passing is NOT done. Every car must be seen spinning in Claude Preview.

**Known preview gotchas** (from prior sessions): the browser caches `main.ts` and GLBs — `preview_stop` + `preview_start` busts it; rAF runs ~1.5fps in preview, so verify via DOM/scene state, not by watching motion.

- [ ] **Step 6.1: Expose a dev probe**

In `src/render/car.ts`, at the end of `createCar` just before `return`, add:

```ts
  const api: Car = {
    // ... (the returned object, unchanged)
  };
  if (import.meta.env.DEV) (window as any).__car = api;
  return api;
```

(Refactor the return statement into `const api = {...}; return api;` for this.) And in `wheels.ts` `buildWheelRig`, before `return`, add:

```ts
  if (import.meta.env.DEV) (window as any).__wheels = per;
```

- [ ] **Step 6.2: Start the preview and drive**

`preview_start` the vite server (`.claude/launch.json` already has it from prior sessions; otherwise add `{"name":"redline3d","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"port":5173}` with cwd pointing at redline3d). Then for **each of the 13 cars**:

1. Open the garage (carpicker), click the car's card.
2. `preview_eval`: hold gas / set lobby drive, then read the probe twice ~1s apart:

```js
(() => { const w = window.__wheels; return w && w.map(p => ({ rx: p.o.rotation.x.toFixed(3), ry: p.o.rotation.y.toFixed(3), r: p.radius.toFixed(3), front: p.front })); })()
```

Pass criteria per car:
- `rotation.x` changes between the two reads while moving (wheels spin), and faster wheels = smaller radius (pink-rod fronts vs rears differ).
- Steering (`preview_eval` a steer input or lane change): fronts' `ry` ≠ 0, rears' `ry` === 0. Flintstone: rollers, `front` handling must not steer them (wheels.length is 2 → no fronts — confirm `front:false` on both).
- `preview_screenshot`: wheels look attached (no orbiting fender chunks, no holes at the wheel wells). This is the one failure mode only eyes catch.
- Spin direction: screenshot won't show it at 1.5fps; check the sign convention instead — while driving forward, `rx` must *decrease* for wheels whose world +X matches car +X (`spinSign` = −1). If every car spins backwards, flip the sign convention in `spinSign` once (single line), re-verify one car.

- [ ] **Step 6.3: Fix what the eyeball pass finds**

Likely finding: a cut grabbed body geometry on one model (visible as a chunk rotating with the wheel). Fix = tighten that model's cut factors in `rig-wheels.mjs` (they are global constants — tighten globally and re-run the fleet: `git checkout -- public/models && node scripts/rig-wheels.mjs && node scripts/rig-wheels.mjs --verify`), re-verify affected cars. Do not hand-edit a GLB.

- [ ] **Step 6.4: Final suite + commit**

```bash
cd redline3d && npx tsc --noEmit && npm test
git add -A src public/models scripts
git commit -m "feat(client): wheel animation verified in-browser across all 13 cars"
```

---

## Self-Review Notes

- **Spec coverage:** detection algorithm (Task 1), named path incl. steering-wheel exclusion (Task 1/2), cut + node convention + extras (Task 2), sanity gates + per-model report (Task 1, `EXPECTED`), all-13 rig (Task 3), runtime spin/steer/geometric front classification + `update(dt, speed)` (Tasks 4–5), vitest for pure helpers (Task 4), mandatory browser verification incl. the orbiting-fender failure mode (Task 6), cache-bust note (Task 6 gotchas). Out-of-scope items (caster swivel, suspension) appear in no task. ✅
- **Flintstone rollers steer guard:** `buildWheelRig` only assigns fronts when `wheels.length >= 3`; rollers (2) never steer. ✅
- **Type consistency:** `WheelRig.spin(dt, speed)` / `steer(angle)` used identically in car.ts; `userData.perpsWheel.radius` written by script `setExtras({ perpsWheel: { radius } })`, read in `collectWheels`/`buildWheelRig`. ✅
