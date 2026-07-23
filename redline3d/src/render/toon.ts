// Game-wide cartoon render style for CARS: cel shading + inverted-hull outlines. `toonify(root)`
// swaps every mesh material under `root` to MeshToonMaterial (preserving map / color / emissive,
// banded through a shared 4-step NearestFilter gradient ramp) and adds an inverted-hull outline
// sibling per mesh (BackSide, near-black, puffed along a SMOOTHED normal so hard-edge normal splits
// on the low-poly GLBs don't leave crease gaps in the silhouette). Cars only — the neon world
// already reads graphic. Outline meshes are named `__outline` and carry no `perpsWheel` userData,
// so wheel rigs (which look up rigged wheels) are unaffected. Toon-only: no restore path.
import * as THREE from "three";

const OUTLINE_COLOR = 0x0a0a12;
const DEFAULT_OUTLINE = 0.22; // world-units of hull puff — a good compromise across camera distances
export const OUTLINE_NAME = "__outline";

// shared 4-step grey ramp (lazy singleton), nearest-filtered → hard cel bands
let _ramp: THREE.CanvasTexture | null = null;
function ramp(): THREE.CanvasTexture {
  if (_ramp) return _ramp;
  const c = document.createElement("canvas"); c.width = 4; c.height = 1;
  const g = c.getContext("2d")!;
  ["#444444", "#888888", "#cccccc", "#ffffff"].forEach((col, i) => { g.fillStyle = col; g.fillRect(i, 0, 1, 1); });
  _ramp = new THREE.CanvasTexture(c);
  _ramp.minFilter = THREE.NearestFilter; _ramp.magFilter = THREE.NearestFilter;
  _ramp.colorSpace = THREE.SRGBColorSpace;
  return _ramp;
}

// average normals across coincident positions (merge-by-position) → one smooth normal per position
// on its OWN attribute, so the inverted hull doesn't split at hard creases while the lit material
// keeps its original (possibly split) normals.
function smoothNormals(geo: THREE.BufferGeometry): Float32Array {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const key = (i: number) => `${Math.round(pos.getX(i) * 1000)}_${Math.round(pos.getY(i) * 1000)}_${Math.round(pos.getZ(i) * 1000)}`;
  const acc = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let v = acc.get(k); if (!v) { v = new THREE.Vector3(); acc.set(k, v); }
    v.x += nor.getX(i); v.y += nor.getY(i); v.z += nor.getZ(i);
  }
  const out = new Float32Array(pos.count * 3);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { tmp.copy(acc.get(key(i))!).normalize(); out[i * 3] = tmp.x; out[i * 3 + 1] = tmp.y; out[i * 3 + 2] = tmp.z; }
  return out;
}

function toonMaterial(src: THREE.Material): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const tm = new THREE.MeshToonMaterial({ gradientMap: ramp() });
  if (s.map) tm.map = s.map;
  if (s.color) tm.color.copy(s.color);
  if (s.emissive) { tm.emissive.copy(s.emissive); tm.emissiveIntensity = s.emissiveIntensity ?? 1; if (s.emissiveMap) tm.emissiveMap = s.emissiveMap; }
  tm.transparent = s.transparent; tm.opacity = s.opacity; tm.side = s.side;
  tm.vertexColors = s.vertexColors; tm.alphaTest = s.alphaTest;
  if (s.alphaMap) tm.alphaMap = s.alphaMap;
  return tm;
}

function outlineMesh(geo: THREE.BufferGeometry, localWidth: number): THREE.Mesh {
  if (!geo.getAttribute("aSmoothNormal")) geo.setAttribute("aSmoothNormal", new THREE.BufferAttribute(smoothNormals(geo), 3));
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: localWidth };
    shader.vertexShader = "attribute vec3 aSmoothNormal;\nuniform float uOutline;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n transformed += normalize(aSmoothNormal) * uOutline;",
    );
  };
  const m = new THREE.Mesh(geo, mat);
  m.name = OUTLINE_NAME;
  return m;
}

/** Cel-shade + outline every mesh under `root` (a car model). Idempotent-safe on already-toon'd
 *  trees (skips `__outline` meshes). `outlineWidth` is the target WORLD thickness of the outline. */
export function toonify(root: THREE.Object3D, opts?: { outlineWidth?: number }): void {
  const target = opts?.outlineWidth ?? DEFAULT_OUTLINE;
  root.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.name !== OUTLINE_NAME) meshes.push(m); });
  const ws = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toonMaterial) : toonMaterial(mesh.material);
    const s = mesh.getWorldScale(ws);
    const scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
    mesh.add(outlineMesh(mesh.geometry, target / scale)); // local puff → constant world outline
  }
}
