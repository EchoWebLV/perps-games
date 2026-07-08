// Dev tool: load a car GLB in a locked orthographic side view, drag circles
// around the wheels, and export their centers/radii in GLB scene units as
// JSON — a manual override feed for scripts/rig-wheels.mjs when the auto
// detection gets a wheel wrong. Dashed grey rings show what the current rig
// thinks the wheels are, so corrections can be drawn against them.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODELS = [
  "clown-car", "cybertruck", "delorean", "flintstone", "helmet", "magnet",
  "orion", "pink-rod", "shopping-cart", "six-wheeler", "skull", "slot-machine",
  "starter", "vaporwave",
  // new common cars (2026-07-06) — not yet wheel-rigged
  "banana", "breaking_rv", "cat", "dragon", "house", "knockout", "trabant", "wiener",
  "cactus", "kraken", "ramen",
];

/** wheels appear as circles only when viewed along their axle */
type Axis = "x" | "z";
/** stored in world coords; the along-view coord is pinned to the model mid-plane */
interface Circle { x: number; y: number; z: number; r: number }

const stage = document.getElementById("stage") as HTMLDivElement;
const modelSel = document.getElementById("model") as HTMLSelectElement;
const axisBtn = document.getElementById("axis") as HTMLButtonElement;
const listEl = document.getElementById("list") as HTMLDivElement;
const outEl = document.getElementById("out") as HTMLTextAreaElement;
const copyBtn = document.getElementById("copy") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

for (const name of MODELS) {
  const opt = document.createElement("option");
  opt.value = opt.textContent = name;
  modelSel.appendChild(opt);
}

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0b0e13");
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const overlay = new THREE.Group();
overlay.renderOrder = 10;
scene.add(overlay);
let grid: THREE.GridHelper | null = null;

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

// ---------------------------------------------------------------- state
let model: THREE.Group | null = null;
const bbox = new THREE.Box3();
const center = new THREE.Vector3();
const size = new THREE.Vector3(1, 1, 1);
let viewAxis: Axis = "x";
let circles: Circle[] = [];
let refCircles: Circle[] = [];
let selected = -1;

// ---------------------------------------------------------------- helpers
/** horizontal world coordinate of a point as seen in the current side view */
function horiz(c: { x: number; z: number }): number {
  return viewAxis === "x" ? c.z : c.x;
}
function setHoriz(c: Circle, v: number): void {
  if (viewAxis === "x") c.z = v; else c.x = v;
}
/** distance between two points in the view plane (ignores the axle axis) */
function planeDist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(horiz(a) - horiz(b), a.y - b.y);
}
/** world units per screen pixel at the current zoom */
function pxToWorld(px: number): number {
  return (px * (camera.right - camera.left)) / camera.zoom / renderer.domElement.clientWidth;
}
/** screen position -> world point on the model's mid-plane */
function toWorld(clientX: number, clientY: number): THREE.Vector3 {
  camera.updateMatrixWorld();
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
  const v = new THREE.Vector3(nx, ny, 0).unproject(camera);
  if (viewAxis === "x") v.x = center.x; else v.z = center.z;
  return v;
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ---------------------------------------------------------------- model
const loader = new GLTFLoader();

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/** wheel_N nodes stamped by rig-wheels.mjs -> reference circles */
function readRig(root: THREE.Object3D): Circle[] {
  const out: Circle[] = [];
  const p = new THREE.Vector3();
  root.traverse((o) => {
    const pw = (o.userData as Record<string, unknown>).perpsWheel as { radius?: number } | undefined;
    if (!pw || typeof pw.radius !== "number") return;
    o.getWorldPosition(p);
    out.push({ x: p.x, y: p.y, z: p.z, r: pw.radius });
  });
  return out;
}

let loadGen = 0;

async function loadModel(name: string): Promise<void> {
  const gen = ++loadGen;
  cancelSpin(""); // restore swapped indices BEFORE the old model is disposed
  statusEl.textContent = "loading…";
  try {
    const gltf = await loader.loadAsync(`/models/${name}.glb`);
    if (gen !== loadGen) {
      disposeTree(gltf.scene); // superseded by a newer pick
      return;
    }
    if (model) {
      scene.remove(model);
      disposeTree(model);
    }
    circles = [];
    selected = -1;
    model = gltf.scene;
    scene.add(model);
    model.updateWorldMatrix(true, true);
    bbox.setFromObject(model);
    bbox.getCenter(center);
    bbox.getSize(size);
    // the long horizontal axis is the car's length; the axle is perpendicular
    viewAxis = size.x >= size.z ? "z" : "x";
    refCircles = readRig(model);
    poseWheels = [];
    if (grid) { scene.remove(grid); grid.dispose(); }
    grid = new THREE.GridHelper(Math.max(size.x, size.z) * 4, 20, 0x243048, 0x1a2230);
    grid.position.set(center.x, bbox.min.y, center.z);
    scene.add(grid);
    statusEl.textContent = refCircles.length ? `rig: ${refCircles.length} wheel nodes` : "rig: none found";
  } catch (err) {
    if (gen !== loadGen) return;
    statusEl.textContent = `load failed: ${String(err)}`;
  }
  frame();
  syncAll();
}

/** reset the camera to a fitted side view along viewAxis */
function frame(): void {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height);
  // a zero-size stage (page loaded in a hidden/detached tab) would make
  // aspect 0 → halfH Infinity → NaN camera the resize handler can't undo
  const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 16 / 9;
  const horizSize = viewAxis === "x" ? size.z : size.x;
  const halfH = Math.max(size.y / 2, horizSize / 2 / aspect) * 1.35;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.zoom = 1;
  const d = Math.max(size.x, size.y, size.z) * 4 + 1;
  camera.position.copy(center);
  if (viewAxis === "x") camera.position.x += d;
  else camera.position.z += d;
  camera.near = 0.01;
  camera.far = d * 4;
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  sun.position.copy(camera.position).add(new THREE.Vector3(2, 5, 1));
  axisBtn.textContent = `view: ${viewAxis}`;
}

// ---------------------------------------------------------------- rings
function ringLine(c: Circle, color: number, dashed: boolean, width2 = false): THREE.Line {
  const pts: THREE.Vector3[] = [];
  const front = (viewAxis === "x" ? bbox.max.x : bbox.max.z) + 0.05;
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    const h = horiz(c) + Math.cos(t) * c.r;
    const y = c.y + Math.sin(t) * c.r;
    pts.push(viewAxis === "x" ? new THREE.Vector3(front, y, h) : new THREE.Vector3(h, y, front));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: c.r * 0.18, gapSize: c.r * 0.12 })
    : new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: width2 ? 2 : 1 });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 10;
  return line;
}

function centerDot(c: Circle, color: number): THREE.Points {
  const front = (viewAxis === "x" ? bbox.max.x : bbox.max.z) + 0.05;
  const p = viewAxis === "x"
    ? new THREE.Vector3(front, c.y, horiz(c))
    : new THREE.Vector3(horiz(c), c.y, front);
  const geo = new THREE.BufferGeometry().setFromPoints([p]);
  const mat = new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false, depthTest: false });
  const dot = new THREE.Points(geo, mat);
  dot.renderOrder = 11;
  return dot;
}

function rebuildRings(): void {
  cancelSpin("circles changed — re-tick spin to preview");
  for (const child of [...overlay.children]) {
    overlay.remove(child);
    const obj = child as THREE.Line;
    obj.geometry?.dispose();
    (obj.material as THREE.Material)?.dispose();
  }
  for (const c of refCircles) overlay.add(ringLine(c, 0x66788f, true));
  circles.forEach((c, i) => {
    const color = i === selected ? 0xffe14d : 0xffb02e;
    overlay.add(ringLine(c, color, false, i === selected));
    overlay.add(centerDot(c, color));
  });
}

// ---------------------------------------------------------------- panel
function syncList(): void {
  listEl.innerHTML = "";
  const hKey = viewAxis === "x" ? "z" : "x";
  circles.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "circle-item" + (i === selected ? " selected" : "");

    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("b");
    title.textContent = `wheel ${i}`;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.onclick = () => {
      circles.splice(i, 1);
      if (selected === i) selected = -1;
      else if (selected > i) selected--;
      syncAll();
    };
    head.append(title, del);

    const fields = document.createElement("div");
    fields.className = "fields";
    const mk = (label: string, get: () => number, set: (v: number) => void) => {
      const wrap = document.createElement("label");
      wrap.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.001";
      input.value = String(round4(get()));
      input.oninput = () => {
        const v = Number(input.value);
        if (input.value.trim() !== "" && Number.isFinite(v)) {
          set(v);
          rebuildRings();
          syncOut();
        }
      };
      wrap.appendChild(input);
      return wrap;
    };
    fields.append(
      mk(hKey, () => horiz(c), (v) => setHoriz(c, v)),
      mk("y", () => c.y, (v) => { c.y = v; }),
      mk("r", () => c.r, (v) => { c.r = Math.max(v, 1e-4); }),
    );

    item.append(head, fields);
    item.onclick = (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || e.target === del) return;
      selected = i;
      syncAll();
    };
    listEl.appendChild(item);
  });
}

function syncOut(): void {
  const hKey = viewAxis === "x" ? "z" : "x";
  outEl.value = JSON.stringify(
    {
      model: modelSel.value,
      axle: viewAxis, // world axis the wheels spin about
      units: "glb-scene",
      circles: circles.map((c) => ({ [hKey]: round4(horiz(c)), y: round4(c.y), r: round4(c.r) })),
    },
    null,
    2,
  );
}

function syncAll(): void {
  rebuildRings();
  syncList();
  syncOut();
}

// ---------------------------------------------------------------- input
type Drag =
  | { kind: "create" | "move" | "resize"; i: number; grab: { h: number; y: number } }
  | { kind: "pan"; cx: number; cy: number };
let drag: Drag | null = null;
let pendingCreate: THREE.Vector3 | null = null;

function hitTest(p: THREE.Vector3): { i: number; kind: "move" | "resize" } | null {
  const band = pxToWorld(10);
  for (let i = circles.length - 1; i >= 0; i--) {
    if (Math.abs(planeDist(p, circles[i]) - circles[i].r) < band) return { i, kind: "resize" };
  }
  for (let i = circles.length - 1; i >= 0; i--) {
    if (planeDist(p, circles[i]) < circles[i].r) return { i, kind: "move" };
  }
  return null;
}

const canvas = renderer.domElement;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
  if (e.button === 2 || e.button === 1) {
    drag = { kind: "pan", cx: e.clientX, cy: e.clientY };
    return;
  }
  if (e.button !== 0) return;
  const p = toWorld(e.clientX, e.clientY);
  const hit = hitTest(p);
  if (hit) {
    selected = hit.i;
    const c = circles[hit.i];
    drag = { kind: hit.kind, i: hit.i, grab: { h: horiz(p) - horiz(c), y: p.y - c.y } };
    syncAll();
  } else {
    pendingCreate = p; // becomes a circle once the drag passes a few pixels
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag && !pendingCreate) return;
  const p = toWorld(e.clientX, e.clientY);
  if (pendingCreate) {
    if (planeDist(p, pendingCreate) > pxToWorld(4)) {
      const c: Circle = { x: pendingCreate.x, y: pendingCreate.y, z: pendingCreate.z, r: planeDist(p, pendingCreate) };
      circles.push(c);
      selected = circles.length - 1;
      drag = { kind: "resize", i: selected, grab: { h: 0, y: 0 } };
      pendingCreate = null;
      syncAll();
    }
    return;
  }
  if (!drag) return;
  if (drag.kind === "pan") {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position
      .addScaledVector(right, -pxToWorld(e.clientX - drag.cx))
      .addScaledVector(up, pxToWorld(e.clientY - drag.cy));
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    return;
  }
  const c = circles[drag.i];
  if (!c) return;
  if (drag.kind === "resize") {
    c.r = Math.max(planeDist(p, c), pxToWorld(2));
  } else {
    setHoriz(c, horiz(p) - drag.grab.h);
    c.y = p.y - drag.grab.y;
  }
  rebuildRings();
  syncList();
  syncOut();
});

canvas.addEventListener("pointerup", (e) => {
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* ditto */ }
  if (pendingCreate) {
    // plain click on empty space: deselect
    pendingCreate = null;
    selected = -1;
    syncAll();
  }
  drag = null;
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * Math.exp(-e.deltaY * 0.0015), 0.2, 60);
    camera.updateProjectionMatrix();
    const after = toWorld(e.clientX, e.clientY);
    camera.position.add(before.sub(after));
  },
  { passive: false },
);

// ---------------------------------------------------------------- wiring
modelSel.onchange = () => void loadModel(modelSel.value);
axisBtn.onclick = () => {
  viewAxis = viewAxis === "x" ? "z" : "x";
  frame();
  syncAll();
};
clearBtn.onclick = () => {
  circles = [];
  selected = -1;
  syncAll();
};
copyBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(outEl.value);
    statusEl.textContent = "copied ✓";
  } catch {
    outEl.select();
    document.execCommand("copy");
    statusEl.textContent = "copied (fallback)";
  }
};
window.addEventListener("resize", () => {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height);
  const aspect = rect.width / Math.max(rect.height, 1);
  camera.left = camera.bottom * aspect;
  camera.right = camera.top * aspect;
  camera.updateProjectionMatrix();
});

// ---- circle spin preview: simulate the cut for the USER's circles ----
// Captures every triangle whose centroid falls inside a drawn circle (in the
// rolling plane), removes it from the body via an index swap (attributes stay
// shared — cheap and lossless) and re-parents it to a group pivoted at the
// circle's center. Spinning that group previews exactly what a re-rig from
// these circles would look like. Skinned meshes (delorean) are skipped.
let preview: { groups: THREE.Group[]; restores: Array<() => void> } | null = null;

function teardownPreview(): void {
  if (!preview) return;
  for (const r of preview.restores) r();
  for (const g of preview.groups) scene.remove(g);
  preview = null;
}

function buildPreview(): number {
  teardownPreview();
  if (!model || !circles.length) return 0;
  const groups = circles.map((c) => {
    const g = new THREE.Group();
    g.position.set(c.x, c.y, c.z);
    scene.add(g);
    g.updateWorldMatrix(true, false);
    return g;
  });
  const restores: Array<() => void> = [];
  const v = new THREE.Vector3();
  model.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) meshes.push(mesh);
  });
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const posA = geo.attributes.position as THREE.BufferAttribute | undefined;
    if (!posA) continue;
    const srcIdx = geo.index;
    const triCount = (srcIdx ? srcIdx.count : posA.count) / 3;
    const at = (k: number) => (srcIdx ? srcIdx.getX(k) : k);
    const buckets: number[][] = circles.map(() => []);
    const rest: number[] = [];
    for (let t = 0; t < triCount; t++) {
      const ia = at(t * 3), ib = at(t * 3 + 1), ic = at(t * 3 + 2);
      let hx = 0, hy = 0;
      for (const ii of [ia, ib, ic]) {
        v.fromBufferAttribute(posA, ii).applyMatrix4(mesh.matrixWorld);
        hx += (viewAxis === "x" ? v.z : v.x) / 3;
        hy += v.y / 3;
      }
      let hit = -1;
      for (let ci = 0; ci < circles.length; ci++) {
        const c = circles[ci];
        const dh = hx - horiz(c), dy = hy - c.y;
        if (dh * dh + dy * dy <= c.r * c.r * 1.1025) { hit = ci; break; } // (r*1.05)²
      }
      if (hit < 0) rest.push(ia, ib, ic);
      else buckets[hit].push(ia, ib, ic);
    }
    if (rest.length === triCount * 3) continue; // nothing captured here
    const needs32 = posA.count > 65535;
    const mk = (arr: number[]) => new THREE.BufferAttribute(needs32 ? new Uint32Array(arr) : new Uint16Array(arr), 1);
    const oldIndex = geo.index;
    geo.setIndex(mk(rest));
    restores.push(() => geo.setIndex(oldIndex));
    buckets.forEach((idxs, ci) => {
      if (!idxs.length) return;
      const ng = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) ng.setAttribute(name, attr as THREE.BufferAttribute);
      ng.setIndex(mk(idxs));
      const cm = new THREE.Mesh(ng, mesh.material);
      cm.matrixAutoUpdate = false;
      cm.matrix.copy(groups[ci].matrixWorld).invert().multiply(mesh.matrixWorld);
      groups[ci].add(cm);
    });
  }
  preview = { groups, restores };
  return groups.length;
}

function applySpin(deg: number): void {
  const rad = (deg * Math.PI) / 180;
  if (preview) {
    const axis = viewAxis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    for (const g of preview.groups) g.quaternion.setFromAxisAngle(axis, rad);
  } else {
    poseTest(deg, 0); // no circles drawn: fall back to the rigged wheels
  }
}

// spin test: user circles when drawn, rigged wheel_N otherwise
let spinOn = false;
let spinAngle = 0;
let lastT = 0;
const spinBox = document.getElementById("spin") as HTMLInputElement;
spinBox.onchange = () => {
  spinOn = spinBox.checked;
  if (spinOn) {
    const n = circles.length ? buildPreview() : 0;
    statusEl.textContent = n ? `spinning ${n} drawn circle${n > 1 ? "s" : ""}` : "spinning the rigged wheels (no circles drawn)";
  } else {
    teardownPreview();
    poseTest(0, 0);
    statusEl.textContent = "";
  }
};
/** any circle/model/view change invalidates the preview — flip the test off */
function cancelSpin(reason: string): void {
  if (!spinOn) return;
  spinOn = false;
  spinBox.checked = false;
  teardownPreview();
  poseTest(0, 0);
  statusEl.textContent = reason;
}
renderer.setAnimationLoop((t) => {
  const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
  lastT = t;
  if (spinOn && model) {
    spinAngle += dt * 120; // 120°/s — slow enough to see wobble/clip
    applySpin(spinAngle);
  }
  renderer.render(scene, camera);
});

// pose test: apply the runtime's exact composition (rest × steer(up) ×
// spin(axle)) to every wheel_N at fixed angles — a wrong pivot or axis shows
// as displaced/tilted geometry in the side view
interface PoseWheel { o: THREE.Object3D; rest: THREE.Quaternion; axle: THREE.Vector3; up: THREE.Vector3 }
let poseWheels: PoseWheel[] = [];
function collectPoseWheels(): void {
  poseWheels = [];
  model?.traverse((o) => {
    const pw = (o.userData as Record<string, any>).perpsWheel;
    if (!pw || !/^wheel_\d+/.test(o.name)) return;
    poseWheels.push({
      o, rest: o.quaternion.clone(),
      axle: new THREE.Vector3(...(pw.axle as number[])).normalize(),
      up: new THREE.Vector3(...(pw.up as number[])).normalize(),
    });
  });
}
function poseTest(spinDeg: number, steerDeg: number): number {
  if (!poseWheels.length) collectPoseWheels();
  const qSpin = new THREE.Quaternion(), qSteer = new THREE.Quaternion();
  for (const p of poseWheels) {
    qSteer.setFromAxisAngle(p.up, (steerDeg * Math.PI) / 180);
    qSpin.setFromAxisAngle(p.axle, (spinDeg * Math.PI) / 180);
    p.o.quaternion.copy(p.rest).multiply(qSteer).multiply(qSpin);
  }
  return poseWheels.length;
}

// dev probe for automated verification
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__marker = {
    get circles() { return circles; },
    get refCircles() { return refCircles; },
    get viewAxis() { return viewAxis; },
    get json() { return outEl.value; },
    poseTest,
    /** build the circle-cut preview (if needed) and pose it at a fixed angle */
    spinPreview(deg: number): { groups: number; capturedMeshes: number } {
      if (!preview && circles.length) buildPreview();
      applySpin(deg);
      return {
        groups: preview?.groups.length ?? 0,
        capturedMeshes: preview?.groups.reduce((s, g) => s + g.children.length, 0) ?? 0,
      };
    },
    /** hide/show wheel nodes — leftover tread shells on the body become visible */
    setWheelsVisible(v: boolean): number {
      if (!poseWheels.length) collectPoseWheels();
      for (const p of poseWheels) p.o.visible = v;
      return poseWheels.length;
    },
    /** per-wheel world bbox — drift under poseTest = pivot/axis error */
    wheelBBoxes(): Record<string, number[]> {
      const out: Record<string, number[]> = {};
      if (!poseWheels.length) collectPoseWheels();
      for (const p of poseWheels) {
        p.o.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(p.o);
        out[p.o.name] = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(4));
      }
      return out;
    },
    /** camera + fit state — NaN here means frame() got bad inputs */
    get camState() {
      return {
        pos: camera.position.toArray(),
        tblr: [camera.top, camera.bottom, camera.left, camera.right],
        zoom: camera.zoom,
        size: size.toArray(),
        center: center.toArray(),
        proj: camera.projectionMatrix.elements.slice(0, 4),
      };
    },
    /** world point -> client pixel coords, for synthetic-pointer tests */
    screenOf(x: number, y: number, z: number) {
      camera.updateMatrixWorld();
      const v = new THREE.Vector3(x, y, z).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        cx: rect.left + ((v.x + 1) / 2) * rect.width,
        cy: rect.top + ((1 - v.y) / 2) * rect.height,
      };
    },
  };
}

void loadModel(MODELS[0]);
