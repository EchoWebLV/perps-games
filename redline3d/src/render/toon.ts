// Game-wide cartoon render style: cel shading + inverted-hull outlines. `toonify(root)` cel-shades a
// CAR (every mesh) — swaps materials to MeshToonMaterial (preserving map / color / emissive, banded
// through a shared 4-step NearestFilter gradient ramp) and adds an inverted-hull outline sibling per
// mesh (BackSide, near-black, puffed along a SMOOTHED normal so hard-edge normal splits on the
// low-poly GLBs don't leave crease gaps in the silhouette). `toonifyWorld(root)` extends the same look
// to WORLDS/STORES: it only converts LIT solids (MeshStandard/Lambert/Phong) and outlines the mid/large
// chunky ones — emissive neon, additive glow, shaders, points, lines and sprites (the light of the art
// style) are left untouched. All outlines share ONE `uOutlineScale` uniform (see setOutlineWidth), so
// the whole game's outline thickness can be rescaled instantly with no rebuilds.
//
// Outline meshes are named `__outline` and carry no `perpsWheel` userData, so wheel rigs (which look up
// rigged wheels) are unaffected. Toon-only: no restore path.
import * as THREE from "three";
import { pNum, pColor } from "../config/visual-presets";

const OUTLINE_COLOR = 0x0a0a12;
const DEFAULT_OUTLINE = 0.22; // world-units of hull puff — a good compromise across camera distances
export const OUTLINE_NAME = "__outline";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Global outline width control. Every hull material multiplies its per-context base width by ONE
// shared uniform object; mutating `.value` rescales every outline in the game on the next frame
// (three re-uploads onBeforeCompile uniforms each draw from the live object) — no material rebuilds.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const OUTLINE_STORAGE = "toon.outlineScale";
// Default global multiplier when the user hasn't dialed one. 0.7 (not 1.0) = a ~30% thinner default:
// the designed base widths read too heavy at chase-cam distance, so every outline (car + world hull)
// ships trimmed. The [ / ] dial + localStorage still let a user thicken back up to 3×.
const DEFAULT_OUTLINE_SCALE = pNum("Global", "outlineScale", 0.7);
const clampScale = (n: number): number => (Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : DEFAULT_OUTLINE_SCALE);
function loadOutlineScale(): number {
  try {
    const raw = localStorage.getItem(OUTLINE_STORAGE);
    if (raw == null) return DEFAULT_OUTLINE_SCALE;      // unset → the trimmed default
    const n = parseFloat(raw);
    return Number.isFinite(n) ? clampScale(n) : DEFAULT_OUTLINE_SCALE;
  } catch { return DEFAULT_OUTLINE_SCALE; }
}
/** the one uniform shared by EVERY outline hull — assigned by reference in each onBeforeCompile */
const outlineScaleUniform: { value: number } = { value: loadOutlineScale() };

/** current global outline multiplier (0.7 = the trimmed default; 1 = each context's designed base) */
export function getOutlineWidth(): number { return outlineScaleUniform.value; }
/** rescale every outline in the game instantly (clamped 0..3), persisted for next boot */
export function setOutlineWidth(scale: number): void {
  outlineScaleUniform.value = clampScale(scale);
  try { localStorage.setItem(OUTLINE_STORAGE, String(outlineScaleUniform.value)); } catch { /* private mode — non-fatal */ }
}
/** The current outline multiplier, for INK LINES (chunky road edges, curbs, sign frames) to key off
 *  so hand-built world lines and shader-puffed car outlines stay proportional. World geometry is
 *  built once at boot, so ink reads the multiplier live at build — thickening the [ / ] dial later
 *  won't rebuild already-placed ink, but a boot with a saved scale rebuilds ink to match. */
export function inkScale(): number { return outlineScaleUniform.value; }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Classic ↔ toon style toggle. toonify/toonifyWorld register each swapped mesh's ORIGINAL and TOON
// material in `matVariants`, and every toonified / variant-bearing root in `styleRoots`. A flip walks
// the roots: restore/reapply materials, show/hide `__outline` hulls, and toggle visibility of any
// object tagged `userData.styleVariant` ('toon' | 'classic'). No disposal — material-pointer and
// visibility swaps only, so switching is instant. Persisted to localStorage `toon.enabled` (default
// FALSE = CLASSIC / OG neon), read before the first toonify so a classic-mode boot ends with original mats + hidden hulls.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const TOON_ENABLED_KEY = "toon.enabled";
export const TOON_DEFAULT = false;
function loadToonEnabled(): boolean {
  try { const raw = localStorage.getItem(TOON_ENABLED_KEY); return raw == null ? TOON_DEFAULT : raw !== "false"; }
  catch { return TOON_DEFAULT; }
}
let _toonEnabled = loadToonEnabled();
type MatOrArray = THREE.Material | THREE.Material[];
const matVariants = new WeakMap<THREE.Mesh, { orig: MatOrArray; toon: MatOrArray }>();
const styleRoots: THREE.Object3D[] = [];
const toonListeners: Array<(on: boolean) => void> = [];
let _restorable = 0; // self-check: number of meshes with a registered material variant

function registerRoot(root: THREE.Object3D): void { if (!styleRoots.includes(root)) styleRoots.push(root); }
function registerMat(mesh: THREE.Mesh, orig: MatOrArray, toon: MatOrArray): void {
  if (!matVariants.has(mesh)) _restorable++;
  matVariants.set(mesh, { orig, toon });
}
/** Full disposal companion for a subtree that's being torn down. Returns the INACTIVE style variant
 *  (the material `refreshToonStyle` isn't currently showing — its counterpart is still on
 *  `mesh.material` for the caller's own dispose walk) of every registered mesh under `root`, so the
 *  caller can release both variants in one deduped pass (a texture shared by both frees once). Also
 *  drops every registered root WITHIN `root` from the style registry (handles a group holding several
 *  toonified roots, not just one exact root) so styleRoots keeps no dead subtree. Returns [] for a
 *  never-toonified subtree. */
export function reclaimToonVariants(root: THREE.Object3D): THREE.Material[] {
  const inSubtree = new Set<THREE.Object3D>();
  const inactive: THREE.Material[] = [];
  root.traverse((o) => {
    inSubtree.add(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const v = matVariants.get(mesh); if (!v) return;
    const off = mesh.material === v.toon ? v.orig : v.toon;
    for (const m of Array.isArray(off) ? off : [off]) inactive.push(m);
    matVariants.delete(mesh); _restorable--;
  });
  for (let i = styleRoots.length - 1; i >= 0; i--) if (inSubtree.has(styleRoots[i])) styleRoots.splice(i, 1);
  return inactive;
}

/** One-call toon teardown for scenes whose disposers free their OWN tracked builds but never walk
 *  mesh materials (worlds / lobbies / per-theme lamp rebuilds): disposes the off-duty variant of
 *  every registered mesh (via reclaimToonVariants, which also drops the subtree's roots from the
 *  style registry), then walks the subtree disposing any attached toon material plus each `__outline`
 *  hull's material. Hull geometry is the source mesh's own — the owner's tracked pass frees it. */
export function disposeToonPass(root: THREE.Object3D): void {
  for (const m of reclaimToonVariants(root)) m.dispose();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if ((m as THREE.MeshToonMaterial | undefined)?.isMeshToonMaterial || mesh.name === OUTLINE_NAME) m?.dispose();
    }
  });
}

/** true when the toon (cel + ink + dusk) style is active; false = the classic pre-toon neon look */
export function isToonEnabled(): boolean { return _toonEnabled; }
/** register a callback fired (with the new state) whenever the style flips or is (re)synced at boot */
export function onToonChanged(cb: (on: boolean) => void): void { toonListeners.push(cb); }

/** apply the CURRENT `_toonEnabled` across every registered root + toggle the `toon-ui` body class +
 *  notify listeners. No persistence — call at boot (after everything is built and listeners wired) to
 *  sync the initial style, and internally on every flip. */
export function refreshToonStyle(): void {
  const on = _toonEnabled;
  for (const root of styleRoots) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { const v = matVariants.get(mesh); if (v) mesh.material = on ? v.toon : v.orig; }
      if (o.name === OUTLINE_NAME) o.visible = on;                                  // inverted hulls: toon only
      const sv = (o.userData as { styleVariant?: string }).styleVariant;
      if (sv === "toon") o.visible = on; else if (sv === "classic") o.visible = !on; // geometry variants
    });
  }
  if (typeof document !== "undefined" && document.body) document.body.classList.toggle("toon-ui", on);
  for (const cb of toonListeners) cb(on);
  console.info(`[toon] style → ${on ? "TOON" : "CLASSIC"} (${_restorable} restorable materials, ${styleRoots.length} roots)`);
}

/** flip the whole game between classic and toon instantly (materials + hulls + geometry variants +
 *  UI class) and persist the choice for next boot. */
export function setToonEnabled(on: boolean): void {
  _toonEnabled = on;
  try { localStorage.setItem(TOON_ENABLED_KEY, String(on)); } catch { /* private mode — non-fatal */ }
  refreshToonStyle();
}

// always-on console hook (the buttons + key T are the primary controls; this mirrors window.__outline)
if (typeof window !== "undefined") {
  (window as unknown as { __toonStyle: (on: boolean) => void }).__toonStyle = (on) => setToonEnabled(!!on);
}

// 4-step grey ramps (lazy singletons), nearest-filtered → hard cel bands. `bands` are sRGB greys.
// null in a non-DOM env (e.g. the node test runner) → toon materials get no gradientMap, which is
// harmless there since nothing is drawn. Real browsers always build the canvas ramp.
function makeRamp(bands: string[]): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas"); c.width = bands.length; c.height = 1;
  const g = c.getContext("2d")!;
  bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(i, 0, 1, 1); });
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// CAR ramp — deep darkest band for punchy cel shading on the well-lit hero cars.
let _ramp: THREE.CanvasTexture | null = null;
function ramp(): THREE.CanvasTexture | null { return (_ramp ??= makeRamp(["#444444", "#888888", "#cccccc", "#ffffff"])); }
// WORLD ramp — LIFTED darkest band (#6e vs #44) so dimly-lit world solids (the lobby especially)
// don't crush into near-black. MeshToonMaterial has no envMap, so this also stands in for the
// scene.environment IBL fill that Standard materials had and toon loses. Cars keep the deeper ramp.
const _worldBands = [pColor("Global", "rampFloor", "#6e6e6e"), pColor("Global", "rampBand2", "#9a9a9a"), "#cccccc", "#ffffff"];
let _worldRamp: THREE.CanvasTexture | null = null;
let _worldRampCanvas: HTMLCanvasElement | null = null;
function drawRampCanvas(canvas: HTMLCanvasElement, bands: string[]): void {
  canvas.width = bands.length; canvas.height = 1;
  const g = canvas.getContext("2d")!;
  bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(i, 0, 1, 1); });
}
function worldRamp(): THREE.CanvasTexture | null {
  if (_worldRamp) return _worldRamp;
  if (typeof document === "undefined") return null;
  _worldRampCanvas = document.createElement("canvas");
  drawRampCanvas(_worldRampCanvas, _worldBands);
  _worldRamp = new THREE.CanvasTexture(_worldRampCanvas);
  _worldRamp.minFilter = THREE.NearestFilter; _worldRamp.magFilter = THREE.NearestFilter;
  _worldRamp.colorSpace = THREE.SRGBColorSpace;
  return _worldRamp;
}
/** DEV Light-Lab hooks: read/rewrite the shared world cel ramp's dark bands live (redraws the shared
 *  texture in place → every world toon material updates next frame). i=0 darkest floor, i=1 2nd band.
 *  Bands are "#rrggbb" hex strings (matching the config file + the Light Lab colour controls). */
export function getWorldRampBand(i: number): string { return _worldBands[i]; }
export function setWorldRampBand(i: number, hex: string): void {
  _worldBands[i] = hex;
  worldRamp();
  if (_worldRamp && _worldRampCanvas) { drawRampCanvas(_worldRampCanvas, _worldBands); _worldRamp.needsUpdate = true; }
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

function toonMaterial(src: THREE.Material, gradientMap: THREE.Texture | null = ramp()): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const tm = new THREE.MeshToonMaterial({ gradientMap });
  if (s.map) tm.map = s.map;
  if (s.color) tm.color.copy(s.color);
  if (s.emissive) { tm.emissive.copy(s.emissive); tm.emissiveIntensity = s.emissiveIntensity ?? 1; if (s.emissiveMap) tm.emissiveMap = s.emissiveMap; }
  tm.transparent = s.transparent; tm.opacity = s.opacity; tm.side = s.side;
  tm.vertexColors = s.vertexColors; tm.alphaTest = s.alphaTest;
  if (s.alphaMap) tm.alphaMap = s.alphaMap;
  return tm;
}

function outlineMesh(src: THREE.Mesh, localWidth: number): THREE.Mesh {
  const geo = src.geometry;
  if (!geo.getAttribute("aSmoothNormal")) geo.setAttribute("aSmoothNormal", new THREE.BufferAttribute(smoothNormals(geo), 3));
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  // Puff at begin_vertex (bind-pose). For a SkinnedMesh hull the later skinning_vertex chunk then
  // transforms the already-puffed position by the bone matrices, so the puff direction is posed
  // with the skin (LBS is linear → offset rotates into the skinned normal). One injection, both cases.
  // The puff = per-hull base width (uOutline) × the ONE global scale (uOutlineScale, shared object).
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: localWidth };
    shader.uniforms.uOutlineScale = outlineScaleUniform; // same object on every hull → global control
    shader.vertexShader = "attribute vec3 aSmoothNormal;\nuniform float uOutline;\nuniform float uOutlineScale;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n transformed += normalize(aSmoothNormal) * uOutline * uOutlineScale;",
    );
  };
  let hull: THREE.Mesh;
  const sk = src as THREE.SkinnedMesh;
  if (sk.isSkinnedMesh) {
    // the DeLorean is skinned — the hull must skin too, or it renders as a bind-pose black blob
    const s = new THREE.SkinnedMesh(geo, mat);
    s.bindMode = sk.bindMode;
    s.bind(sk.skeleton, sk.bindMatrix);
    hull = s;
  } else {
    hull = new THREE.Mesh(geo, mat);
  }
  hull.name = OUTLINE_NAME;
  return hull;
}

/** average absolute world scale of a mesh (uniform-scale approximation), never 0 */
function avgWorldScale(mesh: THREE.Object3D, out: THREE.Vector3): number {
  const s = mesh.getWorldScale(out);
  return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
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
    const orig = mesh.material;
    // NB: wrap the map callback so Array.map's (element,index,array) args don't leak into gradientMap.
    const toon = Array.isArray(orig) ? orig.map((m) => toonMaterial(m)) : toonMaterial(orig);
    registerMat(mesh, orig, toon);
    mesh.material = _toonEnabled ? toon : orig;             // classic-mode boot keeps the original material
    const scale = avgWorldScale(mesh, ws);
    const hull = outlineMesh(mesh, target / scale);        // local puff → constant world outline (skins if src is skinned)
    hull.visible = _toonEnabled;                            // hulls render only in toon mode
    mesh.add(hull);
  }
  registerRoot(root);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// World / store cel-shading. Unlike cars, worlds mix solid bodies with emissive neon (signs, glow
// strips, ring-road lines) and shader/points/sprite glows that ARE the light of the art style. We
// only convert LIT solids and only outline the chunky ones; everything meant to bloom is left alone.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** emissiveIntensity ≥ this (with a non-black emissive) reads as neon/glow → left untouched. The
 *  codebase's solid bodies self-glow at ≤1.05; genuine neon sits at 1.2–1.8, so 1.2 cleanly splits. */
const EMISSIVE_CUT = 1.2;
/** a mesh needs a bbox longest side ≥ this (world units) to earn an outline (skip tiny greebles) */
const OUTLINE_MIN_SIZE = 2;
/** …and a shortest side ≥ this, so flat planes / thin strips / road decals don't get a dark rim */
const FLAT_MIN = 0.4;

/** true when a material is a LIT solid we should cel-shade (and, if chunky, outline). Basic / shader /
 *  points / line / sprite materials, additive glow, emissive-mapped windows and bright neon are left. */
function isConvertibleSolid(mat: THREE.Material): boolean {
  const m = mat as THREE.MeshStandardMaterial & {
    isMeshStandardMaterial?: boolean; isMeshPhysicalMaterial?: boolean;
    isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean;
  };
  const lit = m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial;
  if (!lit) return false;                                        // Basic / Shader / Points / Line / Sprite → neon/glow, leave
  if (m.emissiveMap) return false;                               // texture-driven glow (lit windows) → leave
  if (m.blending !== undefined && m.blending !== THREE.NormalBlending) return false; // additive/multiply glow → leave
  const e = m.emissive;
  const bright = !!e && (e.r + e.g + e.b) > 0.001;
  if (bright && (m.emissiveIntensity ?? 1) >= EMISSIVE_CUT) return false; // neon fixture body → leave
  return true;
}

/** convert a mesh's solid material(s) to toon, register the original↔toon variant, and apply whichever
 *  is active per `_toonEnabled`. Returns true if anything was convertible (→ eligible for an outline). */
function convertMeshMaterials(mesh: THREE.Mesh): boolean {
  const orig = mesh.material;
  if (Array.isArray(orig)) {
    let any = false;
    const toon = orig.map((mm) => { if (isConvertibleSolid(mm)) { any = true; return toonMaterial(mm, worldRamp()); } return mm; });
    if (!any) return false;
    registerMat(mesh, orig, toon);
    mesh.material = _toonEnabled ? toon : orig;
    return true;
  }
  if (isConvertibleSolid(orig)) {
    const toon = toonMaterial(orig, worldRamp()); // LIFTED world ramp → dim solids don't crush to black
    registerMat(mesh, orig, toon);
    mesh.material = _toonEnabled ? toon : orig;
    return true;
  }
  return false;
}

/** does this mesh's world-space footprint clear the mid/large + not-flat gates for an outline? */
function earnsOutline(mesh: THREE.Mesh, minSize: number, ws: THREE.Vector3): boolean {
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return false;
  const scale = avgWorldScale(mesh, ws);
  const sx = (bb.max.x - bb.min.x) * scale, sy = (bb.max.y - bb.min.y) * scale, sz = (bb.max.z - bb.min.z) * scale;
  const maxDim = Math.max(sx, sy, sz), minDim = Math.min(sx, sy, sz);
  return maxDim >= minSize && minDim >= FLAT_MIN;
}

/** Cel-shade a WORLD/STORE subtree: convert lit solids to toon, outline the chunky ones, and leave
 *  every neon / glow / shader / points / sprite element untouched. Subtrees flagged with
 *  `object.userData.toonSkip = true` (e.g. a synthwave backdrop, ghost-car group) are skipped whole.
 *  InstancedMesh sources are cel-shaded but NOT outlined (a per-instance hull is skipped by design).
 *  Returns rough self-check counts for build-time logging. */
export function toonifyWorld(
  root: THREE.Object3D,
  opts?: { outlineWidth?: number; outlineMinSize?: number },
): { toonMats: number; hulls: number; instanced: number } {
  const target = opts?.outlineWidth ?? DEFAULT_OUTLINE;
  const minSize = opts?.outlineMinSize ?? OUTLINE_MIN_SIZE;
  root.updateWorldMatrix(true, true);

  // manual walk so we can prune whole `toonSkip` subtrees (traverse() can't skip a branch)
  const meshes: THREE.Mesh[] = [];
  const stack: THREE.Object3D[] = [root];
  while (stack.length) {
    const o = stack.pop()!;
    if (o !== root && o.userData?.toonSkip) continue; // don't descend into flagged subtrees
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name !== OUTLINE_NAME) meshes.push(m);
    for (const c of o.children) stack.push(c);
  }

  const ws = new THREE.Vector3();
  let toonMats = 0, hulls = 0, instanced = 0;
  for (const mesh of meshes) {
    const converted = convertMeshMaterials(mesh);
    if (!converted) continue;
    toonMats++;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) { instanced++; continue; } // per-instance hull skipped by design
    if (!earnsOutline(mesh, minSize, ws)) continue;
    const scale = avgWorldScale(mesh, ws);
    const hull = outlineMesh(mesh, target / scale);
    hull.visible = _toonEnabled;                            // hulls render only in toon mode
    mesh.add(hull);
    hulls++;
  }
  registerRoot(root);
  return { toonMats, hulls, instanced };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dev-only outline-thickness controls (Vite DEV builds only; tree-shaken from production). Keys
// `[` / `]` step the global scale −/+0.1 with a small toast; `window.__outline(scale)` sets it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
let _devInstalled = false;
let _toastEl: HTMLDivElement | null = null;
let _toastTimer: ReturnType<typeof setTimeout> | undefined;
function outlineToast(): void {
  if (typeof document === "undefined") return;
  if (!_toastEl) {
    _toastEl = document.createElement("div");
    _toastEl.style.cssText = [
      "position:fixed", "left:50%", "bottom:24px", "transform:translateX(-50%)", "z-index:2147483647",
      "padding:7px 14px", "border-radius:8px", "pointer-events:none",
      "font:700 13px/1 'Chakra Petch',ui-monospace,monospace", "letter-spacing:.06em",
      "color:#eaf2ff", "background:rgba(10,8,22,.9)", "border:1px solid rgba(132,150,224,.4)",
      "box-shadow:0 4px 16px rgba(0,0,0,.5)",
    ].join(";");
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = `outline ×${getOutlineWidth().toFixed(1)}`;
  _toastEl.style.opacity = "1";
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.style.opacity = "0"; }, 900);
}

/** wire the DEV outline hotkeys + console hook once. No-op in production or if already installed. */
export function installOutlineDevControls(): void {
  if (!import.meta.env.DEV) return;
  if (_devInstalled) return;
  _devInstalled = true;
  (window as unknown as { __outline: (s: number) => void }).__outline = (s: number) => { setOutlineWidth(s); outlineToast(); };
  const step = (d: number) => { setOutlineWidth(Math.round((getOutlineWidth() + d) * 10) / 10); outlineToast(); };
  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "[") step(-0.1);
    else if (e.key === "]") step(0.1);
  });
}
