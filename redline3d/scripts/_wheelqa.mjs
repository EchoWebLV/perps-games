// wheel QA: for each wheel_N in a rigged GLB, measure
//   1. pivot offset in the rolling plane (node origin vs captured-geometry center)
//   2. angular coverage of the outer tread band (missing crescent = clipped cut)
//   3. leftover tire ring left in BODY geometry (above AND below hub)
//   4. stamped axle/up vectors
//
// Measured in SCENE units around each wheel's world pivot, in the frame the
// runtime spins on: the STAMPED extras.perpsWheel axle/up mapped to world.
// Cut wheels (scene-root nodes, axle=[1,0,0]) measure exactly as the original
// (y,z)-plane math; tagged nodes with their own frames/inherited scale
// (orion's axle pairs, cybertruck's tire+rim children) and skinned joints
// (delorean) are measured truthfully instead of in a wrong fixed frame.
//
// Wheel membership: subtree meshes (world-transformed), plus skinned verts
// dominantly weighted to the wheel joint (world = jointWorld × IBM × pos).
// Angular coverage counts triangle EDGE samples as well as verts, so a closed
// low-poly surface (flintstone's flat log quads) does not read as a hole — a
// real clipped crescent has neither verts nor edges there and still fails.
// Coverage/roundness/tread-presence gate per co-located GROUP (tire+rim spin
// as one wheel and share the harmonized tire radius — a rim alone has no
// tread band by design); pivot and steer-arm gate per node.
// usage: node scripts/_wheelqa.mjs public/models/<m>.glb [--assert]
import { NodeIO } from "@gltf-transform/core";

const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const rot3 = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];
const mat4mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
const wheels = [];
const visit0 = (node) => { if (/^wheel_\d+$/.test(node.getName())) wheels.push({ node, verts: [], edges: [] }); for (const c of node.listChildren()) visit0(c); };
for (const n of scene.listChildren()) visit0(n);
const byNode = new Map(wheels.map((w) => [w.node, w]));

// collect world-space wheel verts + intra-wheel triangle edges; everything
// else lands in bodyVerts (via joints for skinned prims)
const bodyVerts = [];
const collect = (node, wheelEntry) => {
  const owner = byNode.get(node) ?? wheelEntry;
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    const skin = node.getSkin();
    const sj = skin ? skin.listJoints() : null;
    const ibm = skin ? skin.getInverseBindMatrices()?.getArray() : null;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute("POSITION").getArray();
      const idxAcc = prim.getIndices();
      const idx = idxAcc ? idxAcc.getArray() : Array.from({ length: pos.length / 3 }, (_, k) => k);
      const uniq = [...new Set(idx)];
      const joints = prim.getAttribute("JOINTS_0")?.getArray();
      const weights = prim.getAttribute("WEIGHTS_0")?.getArray();
      if (!owner && sj && ibm && joints && weights) {
        // skinned prim: a vertex belongs to its dominant wheel joint
        const jw = new Map(); // joint index -> world × invBind
        const jmat = (bj) => {
          let m2 = jw.get(bj);
          if (!m2) {
            m2 = bj >= 0 ? mat4mul(Array.from(sj[bj].getWorldMatrix()), Array.from(ibm.slice(bj * 16, bj * 16 + 16))) : m;
            jw.set(bj, m2);
          }
          return m2;
        };
        const memb = new Map(); // source index -> { w, vi } for edge pairing
        for (const vi of uniq) {
          let bj = -1, bw = 0;
          for (let k = 0; k < 4; k++) { const ww = weights[vi * 4 + k]; if (ww > bw) { bw = ww; bj = joints[vi * 4 + k]; } }
          const wEntry = bj >= 0 && bw >= 0.5 ? byNode.get(sj[bj]) : undefined;
          const world = xform(jmat(bj), pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          if (wEntry) { memb.set(vi, { w: wEntry, vi: wEntry.verts.length }); wEntry.verts.push(world); }
          else bodyVerts.push(world);
        }
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const a = memb.get(idx[t]), b = memb.get(idx[t + 1]), c = memb.get(idx[t + 2]);
          if (a && b && a.w === b.w) a.w.edges.push([a.vi, b.vi]);
          if (b && c && b.w === c.w) b.w.edges.push([b.vi, c.vi]);
          if (c && a && c.w === a.w) c.w.edges.push([c.vi, a.vi]);
        }
      } else if (owner) {
        const base = owner.verts.length;
        const remap = new Map();
        uniq.forEach((vi, k) => { remap.set(vi, base + k); owner.verts.push(xform(m, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2])); });
        for (let t = 0; t + 2 < idx.length; t += 3)
          owner.edges.push(
            [remap.get(idx[t]), remap.get(idx[t + 1])],
            [remap.get(idx[t + 1]), remap.get(idx[t + 2])],
            [remap.get(idx[t + 2]), remap.get(idx[t])],
          );
      } else {
        for (const vi of uniq) bodyVerts.push(xform(m, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]));
      }
    }
  }
  for (const c of node.listChildren()) collect(c, owner);
};
for (const n of scene.listChildren()) collect(n, null);

// --assert: turn the measurements into hard gates (thresholds sit well outside
// every known-good rebake: pivot 0.0%, emptyBins 0, roundness 0.96-1.05,
// treadXc ≤2.8%) so fix-wheels.mjs can fail fast instead of a human eyeballing
const assert = process.argv.includes("--assert");
const fails = [];
const gate = (name, ok, msg) => { if (!ok) fails.push(`${name}: ${msg}`); };
const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];

for (const w of wheels) {
  const pw = w.node.getExtras()?.perpsWheel;
  gate(w.node.getName(), pw?.radius > 0, `missing/bad extras.perpsWheel ${JSON.stringify(pw)}`);
  gate(w.node.getName(), w.verts.length > 100, `only ${w.verts.length} verts captured — hollow cut?`);
  if (!(pw?.radius > 0) || w.verts.length === 0) continue;
  const r = pw.radius;
  const wm = w.node.getWorldMatrix();
  const hub = [wm[12], wm[13], wm[14]];
  // world basis from the stamped node-local axle/up — the frame the runtime
  // spins on. Cut wheels (axle=x̂, up=ŷ, yaw-only nodes) reproduce the old
  // (y,z)-plane math exactly.
  const a = norm(rot3(wm, pw.axle));
  const upW = rot3(wm, pw.up ?? [0, 1, 0]);
  const upDot = dot(upW, a);
  const tHat = norm([upW[0] - upDot * a[0], upW[1] - upDot * a[1], upW[2] - upDot * a[2]]);
  const sHat = cross(a, tHat);
  const S = [], T = [], X = [];
  for (const p of w.verts) {
    const rel = [p[0] - hub[0], p[1] - hub[1], p[2] - hub[2]];
    S.push(dot(rel, sHat)); T.push(dot(rel, tHat)); X.push(dot(rel, a));
  }
  w.S = S; w.T = T; w.X = X; w.r = r; w.hub = hub;
  const ss = [...S].sort((x, y) => x - y), ts = [...T].sort((x, y) => x - y);
  const s0 = q(ss, 0.005), s1 = q(ss, 0.995), t0 = q(ts, 0.005), t1 = q(ts, 0.995);
  const ds = s1 - s0, dt = t1 - t0;
  w.ds = ds; w.dt = dt;
  // pivot offset: geometry center (bottom-anchored up like the rig) vs origin
  const ct = t0 + ds / 2, cs = (s0 + s1) / 2;
  // angular coverage of outer band (0.85r..1.15r): 24 bins over the rolling
  // plane, fed by verts AND edge samples (closed low-poly ≠ hole)
  const bins = new Array(24).fill(0);
  let outer = 0;
  const binPt = (sv, tv) => {
    const d = Math.hypot(tv, sv);
    if (d < r * 0.85 || d > r * 1.15) return;
    outer++;
    bins[Math.floor(((Math.atan2(tv, sv) + Math.PI) / (2 * Math.PI)) * 24) % 24]++;
  };
  for (let i = 0; i < S.length; i++) binPt(S[i], T[i]);
  for (const [ea, eb] of w.edges)
    for (const f of [0.25, 0.5, 0.75])
      binPt(S[ea] + (S[eb] - S[ea]) * f, T[ea] + (T[eb] - T[ea]) * f);
  w.bins = bins; w.outer = outer;
  // leftover ring: body verts inside this wheel's cylinder, radial 0.5r..1.05r,
  // split above/below hub (world frame)
  const xs2 = [...X].sort((x, y) => x - y);
  const widX = q(xs2, 0.995) - q(xs2, 0.005);
  let above = 0, below = 0;
  for (const v of bodyVerts) {
    const rel = [v[0] - hub[0], v[1] - hub[1], v[2] - hub[2]];
    const along = dot(rel, a);
    if (Math.abs(along) > widX * 0.7) continue; // within the wheel's width-ish
    const rad = Math.hypot(rel[0] - along * a[0], rel[1] - along * a[1], rel[2] - along * a[2]);
    if (rad < r * 0.5 || rad > r * 1.05) continue;
    if (rel[1] > 0) above++; else below++;
  }
  console.log(
    `${w.node.getName()} r=${r.toFixed(3)} verts=${w.verts.length} | pivotOff up=${(100 * ct / r).toFixed(1)}% len=${(100 * cs / r).toFixed(1)}% | ` +
    `lenExt=${ds.toFixed(3)} upExt=${dt.toFixed(3)} | outerBand=${outer} emptyBins=${bins.filter((b) => b < 3).length}/24 | ` +
    `bodyRing above=${above} below=${below} | axle=[${pw.axle.map((v) => v.toFixed(2)).join(",")}]`
  );
  gate(w.node.getName(), Math.abs(ct / r) <= 0.02 && Math.abs(cs / r) <= 0.02,
    `pivot off center up=${(100 * ct / r).toFixed(1)}% len=${(100 * cs / r).toFixed(1)}% (limit 2%)`);
}

// --- group gates: co-located wheel_N nodes (tire+rim) spin as ONE wheel and
// share the harmonized tire radius, so tread coverage and roundness are
// judged on the pooled geometry (same grouping rule as rig-wheels.mjs)
const measured = wheels.filter((w) => w.S);
const groups = [];
for (const w of measured) {
  const g = groups.find((g) => g.some((m) =>
    Math.hypot(m.hub[0] - w.hub[0], m.hub[1] - w.hub[1], m.hub[2] - w.hub[2]) < Math.max(m.r, w.r) * 0.5));
  if (g) g.push(w); else groups.push([w]);
}
for (const g of groups) {
  const name = g.map((w) => w.node.getName()).join("+");
  const bins = new Array(24).fill(0);
  for (const w of g) for (let i = 0; i < 24; i++) bins[i] += w.bins[i];
  const emptyBins = bins.filter((b) => b < 3).length;
  // roundness of the pooled ring: widest member extents (the tire's)
  const ds = Math.max(...g.map((w) => w.ds)), dt = Math.max(...g.map((w) => w.dt));
  if (g.length > 1) console.log(`group ${name}: outerBand=${g.reduce((s, w) => s + w.outer, 0)} emptyBins=${emptyBins}/24 (up/len=${(dt / ds).toFixed(2)})`);
  gate(name, emptyBins === 0, `${emptyBins}/24 empty tread bins — clipped cut crescent`);
  gate(name, dt / ds >= 0.85 && dt / ds <= 1.15, `cross-section not round: up/len=${(dt / ds).toFixed(2)} (limits 0.85-1.15)`);
  gate(name, g.some((w) => w.outer > 0), "no tread verts in the outer band");
}

// --- steer-arm check: where is the TIRE TREAD's width-center along the axle
// relative to the pivot (0)? Steering rotates about up through the pivot: any
// offset = sideways swing arm. Tread = outer-band verts only; rim-only nodes
// of a tire+rim group have none and are covered by the group tread gate.
console.log("\n--- steer-arm (tread center along the axle vs pivot, % of r) ---");
for (const w of measured) {
  const r = w.r;
  const xs = [];
  for (let i = 0; i < w.S.length; i++) {
    const d = Math.hypot(w.T[i], w.S[i]);
    if (d >= r * 0.85 && d <= r * 1.15) xs.push(w.X[i]);
  }
  if (!xs.length) continue;
  xs.sort((a, b) => a - b);
  const qx = (f) => xs[Math.min(xs.length - 1, Math.floor(xs.length * f))];
  const mid = (qx(0.01) + qx(0.99)) / 2;
  const fullXs = [...w.X].sort((a, b) => a - b);
  const qf = (f) => fullXs[Math.min(fullXs.length - 1, Math.floor(fullXs.length * f))];
  console.log(`${w.node.getName()} treadXc=${mid.toFixed(3)} (${(100 * mid / r).toFixed(1)}% of r) | treadXext=[${qx(0.01).toFixed(3)},${qx(0.99).toFixed(3)}] fullXext=[${qf(0.005).toFixed(3)},${qf(0.995).toFixed(3)}]`);
  gate(w.node.getName(), Math.abs(mid / r) <= 0.05, `tread center ${(100 * mid / r).toFixed(1)}% of r off the steer pivot (limit 5%)`);
}

if (assert) {
  if (fails.length) {
    console.error(`\n✗ wheel QA failed (${fails.length}):`);
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\n✔ wheel QA gates passed (${wheels.length} wheels)`);
}
