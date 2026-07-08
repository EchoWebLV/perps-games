// Probe: histogram of vertex z inside the pink-rod FRONT wheel's drawn side-view
// circle (x=-0.6867, y=-0.2722, r=0.1411), +z side, split into "tread ring"
// (radial 0.85r..1.05r from circle center) vs "all in circle" vs the rigger's
// bottom-sector filter. World-space verts (node transforms applied). Bins 0.01.
import { NodeIO } from "@gltf-transform/core";
const io = new NodeIO();
const doc = await io.read(process.argv[2]);
const C = { x: +process.argv[3], y: +process.argv[4], r: +process.argv[5] };
const all = new Map(), ring = new Map(), bottom = new Map();
const mul = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const a = pos.getArray();
    for (let i = 0; i < a.length; i += 3) {
      const [x, y, z] = mul(m, a[i], a[i + 1], a[i + 2]);
      if (z <= 0) continue;
      const d = Math.hypot(x - C.x, y - C.y);
      if (d > C.r * 1.05) continue;
      const b = Math.round(z * 100) / 100;
      all.set(b, (all.get(b) ?? 0) + 1);
      if (d >= C.r * 0.85) ring.set(b, (ring.get(b) ?? 0) + 1);
      if (y < C.y - 0.35 * C.r) bottom.set(b, (bottom.get(b) ?? 0) + 1);
    }
  }
}
const bins = [...all.keys()].sort((p, q) => p - q);
console.log("   z    all  ring(0.85-1.05r)  bottomSector");
for (const b of bins)
  console.log(b.toFixed(2).padStart(5), String(all.get(b)).padStart(6), String(ring.get(b) ?? 0).padStart(8), String(bottom.get(b) ?? 0).padStart(10));
