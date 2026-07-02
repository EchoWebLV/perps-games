// wheel QA: for each wheel_N in a rigged GLB, measure
//   1. pivot offset in the rolling plane (node origin vs captured-geometry center)
//   2. angular coverage of the outer tread band (missing crescent = clipped cut)
//   3. leftover tire ring left in BODY geometry (above AND below hub)
//   4. stamped axle/up vectors
// usage: node scripts/_wheelqa.mjs public/models/<m>.glb
import { NodeIO } from "@gltf-transform/core";

const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const xform = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

const wheels = [];
const bodyVerts = []; // scene-space verts of everything that is NOT a wheel node
const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
const visit = (node, inWheel) => {
  const isWheel = /^wheel_\d+$/.test(node.getName());
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute("POSITION").getArray();
      const idx = prim.getIndices()?.getArray();
      const indices = idx ? [...new Set(idx)] : Array.from({ length: pos.length / 3 }, (_, k) => k);
      if (isWheel || inWheel) {
        // keep LOCAL coords for the wheel (pivot analysis) + world for ring scan
        const entry = wheels.find((w) => w.node === (isWheel ? node : inWheel));
        const local = indices.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        entry.local.push(...local);
      } else {
        for (const i of indices) bodyVerts.push(xform(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      }
    }
  }
  if (isWheel) wheels.push({ node, local: [] });
  for (const c of node.listChildren()) visit(c, isWheel ? node : inWheel);
};
// two passes: create wheel entries on discovery, then collect
const visit0 = (node) => { if (/^wheel_\d+$/.test(node.getName())) wheels.push({ node, local: [] }); for (const c of node.listChildren()) visit0(c); };
for (const n of scene.listChildren()) visit0(n);
const collect = (node, wheelEntry) => {
  const isWheel = wheels.find((w) => w.node === node);
  const owner = isWheel ?? wheelEntry;
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute("POSITION").getArray();
      const idx = prim.getIndices()?.getArray();
      const indices = idx ? [...new Set(idx)] : Array.from({ length: pos.length / 3 }, (_, k) => k);
      if (owner) for (const i of indices) owner.local.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      else for (const i of indices) bodyVerts.push(xform(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    }
  }
  for (const c of node.listChildren()) collect(c, owner);
};
for (const n of scene.listChildren()) collect(n, null);

for (const w of wheels) {
  const pw = w.node.getExtras()?.perpsWheel;
  const r = pw.radius;
  const t = w.node.getTranslation();
  const wm = w.node.getWorldMatrix();
  // local frame: axle = +x (cut wheels), rolling plane = (y, z)
  const ys = w.local.map((p) => p[1]).sort((a, b) => a - b);
  const zs = w.local.map((p) => p[2]).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
  const y0 = q(ys, 0.005), y1 = q(ys, 0.995), z0 = q(zs, 0.005), z1 = q(zs, 0.995);
  const dz = z1 - z0, dy = y1 - y0;
  // pivot offset: geometry center (bottom-anchored y like the rig) vs origin
  const cy = y0 + dz / 2, cz = (z0 + z1) / 2;
  // angular coverage of outer band (0.85r..1.1r): 24 bins over the rolling plane
  const bins = new Array(24).fill(0);
  let outer = 0;
  for (const p of w.local) {
    const d = Math.hypot(p[1], p[2]);
    if (d < r * 0.85 || d > r * 1.15) continue;
    outer++;
    bins[Math.floor(((Math.atan2(p[1], p[2]) + Math.PI) / (2 * Math.PI)) * 24) % 24]++;
  }
  const emptyBins = bins.filter((b) => b < 3).length;
  // leftover ring: body verts inside this wheel's cylinder, radial 0.5r..1.05r,
  // split above/below hub (world frame; axle from node world matrix col-x)
  const ax = [wm[0], wm[1], wm[2]];
  const al = Math.hypot(...ax) || 1;
  const axn = ax.map((v) => v / al);
  const hub = [wm[12], wm[13], wm[14]];
  let above = 0, below = 0;
  for (const v of bodyVerts) {
    const rel = [v[0] - hub[0], v[1] - hub[1], v[2] - hub[2]];
    const along = rel[0] * axn[0] + rel[1] * axn[1] + rel[2] * axn[2];
    if (Math.abs(along) > dy * 0.7) continue; // within the wheel's width-ish
    const rad = Math.hypot(rel[0] - along * axn[0], rel[1] - along * axn[1], rel[2] - along * axn[2]);
    if (rad < r * 0.5 || rad > r * 1.05) continue;
    if (rel[1] > 0) above++; else below++;
  }
  console.log(
    `${w.node.getName()} r=${r.toFixed(3)} | pivotOff y=${(100 * cy / r).toFixed(1)}% z=${(100 * cz / r).toFixed(1)}% | ` +
    `zExt=${dz.toFixed(3)} yExt=${dy.toFixed(3)} (yExt/zExt=${(dy / dz).toFixed(2)}) | ` +
    `outerBand=${outer} emptyBins=${emptyBins}/24 | bodyRing above=${above} below=${below} | ` +
    `axle=[${pw.axle.map((v) => v.toFixed(2)).join(",")}]`
  );
}

// --- steer-arm check: where is the TIRE TREAD's width-center along the axle
// (local x) relative to the pivot (x=0)? Steering rotates about up through the
// pivot: any offset = sideways swing arm. Tread = outer-band verts only.
console.log("\n--- steer-arm (tread x-center vs pivot, % of r) ---");
for (const w of wheels) {
  const r = w.node.getExtras().perpsWheel.radius;
  const xs = [];
  for (const p of w.local) {
    const d = Math.hypot(p[1], p[2]);
    if (d >= r * 0.85 && d <= r * 1.15) xs.push(p[0]);
  }
  xs.sort((a, b) => a - b);
  const q = (f) => xs[Math.min(xs.length - 1, Math.floor(xs.length * f))];
  const mid = (q(0.01) + q(0.99)) / 2;
  const fullXs = w.local.map((p) => p[0]).sort((a, b) => a - b);
  const qf = (f) => fullXs[Math.min(fullXs.length - 1, Math.floor(fullXs.length * f))];
  console.log(`${w.node.getName()} treadXc=${mid.toFixed(3)} (${(100 * mid / r).toFixed(1)}% of r) | treadXext=[${q(0.01).toFixed(3)},${q(0.99).toFixed(3)}] fullXext=[${qf(0.005).toFixed(3)},${qf(0.995).toFixed(3)}]`);
}
