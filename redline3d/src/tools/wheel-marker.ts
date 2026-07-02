// Dev tool: load a car GLB in a locked orthographic side view, drag circles
// around the wheels, and export their centers/radii in GLB scene units as
// JSON — a manual override feed for scripts/rig-wheels.mjs when the auto
// detection gets a wheel wrong. Dashed grey rings show what the current rig
// thinks the wheels are, so corrections can be drawn against them.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODELS = [
  "clown-car", "cybertruck", "delorean", "flintstone", "helmet", "orion",
  "pink-rod", "shopping-cart", "six-wheeler", "skull", "slot-machine",
  "starter", "vaporwave",
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

async function loadModel(name: string): Promise<void> {
  statusEl.textContent = "loading…";
  if (model) {
    scene.remove(model);
    disposeTree(model);
    model = null;
  }
  circles = [];
  selected = -1;
  try {
    const gltf = await loader.loadAsync(`/models/${name}.glb`);
    model = gltf.scene;
    scene.add(model);
    model.updateWorldMatrix(true, true);
    bbox.setFromObject(model);
    bbox.getCenter(center);
    bbox.getSize(size);
    // the long horizontal axis is the car's length; the axle is perpendicular
    viewAxis = size.x >= size.z ? "z" : "x";
    refCircles = readRig(model);
    if (grid) { scene.remove(grid); grid.dispose(); }
    grid = new THREE.GridHelper(Math.max(size.x, size.z) * 4, 20, 0x243048, 0x1a2230);
    grid.position.set(center.x, bbox.min.y, center.z);
    scene.add(grid);
    statusEl.textContent = refCircles.length ? `rig: ${refCircles.length} wheel nodes` : "rig: none found";
  } catch (err) {
    statusEl.textContent = `load failed: ${String(err)}`;
  }
  frame();
  syncAll();
}

/** reset the camera to a fitted side view along viewAxis */
function frame(): void {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height);
  const aspect = rect.width / Math.max(rect.height, 1);
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
        if (Number.isFinite(v)) {
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

renderer.setAnimationLoop(() => renderer.render(scene, camera));

// dev probe for automated verification
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__marker = {
    get circles() { return circles; },
    get refCircles() { return refCircles; },
    get viewAxis() { return viewAxis; },
    get json() { return outEl.value; },
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
