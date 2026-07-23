// Standalone neon-void circuit for the spectator-race preview (DEV-ONLY, used by
// src/race-preview.ts). Replaces the lobby plaza ring. The racing line is a CLOSED
// CatmullRom curve through hand-placed control points forming a kart-style circuit — a long
// start/finish straight, a sweeping right, a light chicane, a sweeper, and a tight hairpin.
// Arc-length parameterization (high arcLengthDivisions) makes getPointAt/getTangentAt true
// world-distance lookups, so car speed is real world speed everywhere. Nothing here touches
// the game; it is imported only by the dev harness.
import * as THREE from "three";
import { toonifyWorld, inkScale } from "./toon";

export interface TrackPose { x: number; z: number; rot: number; tx: number; tz: number }
export interface RaceTrack {
  group: THREE.Group;
  curve: THREE.CatmullRomCurve3;
  length: number;
  /** world pose at arc-length s (wraps) with a constant lateral lane offset */
  poseAt(s: number, lateral: number): TrackPose;
  /** universal cornering speed factor at arc-length s, in [CORNER_MIN, 1] (1 = straight) */
  cornerFactorAt(s: number): number;
  tightestTurnS: number;
  /** arc-length of each corner apex (for turn signs, apex cams, curbs) */
  corners: number[];
  center: THREE.Vector3;
  radius: number;
  /** radius of a circle enclosing the whole circuit (for placing the world outside it) */
  boundingRadius: number;
  /** min distance from (x,z) to the racing line — for env prop-placement clearance */
  distanceToCenterline(x: number, z: number): number;
  startPose: TrackPose;
  update(dt: number): void;
  dispose(): void;
}

// ---- canvas-texture helpers (repeated detail baked into textures → few draw calls) ----
// one sponsor board on its own canvas (used by discrete board planes — no tiling, no shared UVs)
const INK_HEX = "#07060d"; // near-black cartoon ink for sign/board frames (matches toon outline)
function makeBoardTexture(label: string, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0a0713"; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = INK_HEX; g.lineWidth = 18; g.strokeRect(9, 9, c.width - 18, c.height - 18); // bold dark ink frame
  g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(22, 22, c.width - 44, c.height - 44);  // colored inner border
  g.fillStyle = color; g.font = "700 62px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = color; g.shadowBlur = 22;
  g.fillText(label, c.width / 2, c.height / 2 + 2);
  return c;
}
function makeSignTexture(label: string, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = 128; c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0a0713"; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = INK_HEX; g.lineWidth = 15; g.strokeRect(7, 7, 114, 114); // bold dark ink frame
  g.strokeStyle = color; g.lineWidth = 8; g.strokeRect(18, 18, 92, 92);    // colored inner border
  g.fillStyle = color; g.font = "700 62px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = color; g.shadowBlur = 16; g.fillText(label, 64, 68);
  return c;
}
function makeBannerTexture(): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0a0713"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = INK_HEX; g.fillRect(0, 0, c.width, 9); g.fillRect(0, c.height - 9, c.width, 9); // dark ink top/bottom rails
  const msg = "  OCTANE  •  PERPS RACE  •  VRF VERIFIED  ";
  g.fillStyle = "#27e7ff"; g.font = "700 54px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "left"; g.textBaseline = "middle";
  g.shadowColor = "#27e7ff"; g.shadowBlur = 16;
  g.fillText(msg, 12, c.height / 2);
  return c;
}

// control points (pre-scale). Three collinear points hold the start/finish straight truly
// straight; the rest shape the turns. Order sets travel direction (+X along the straight first).
const RAW: [number, number][] = [
  // Single-winding loop, verified offline for min radius of curvature (tightest = the chicane,
  // radius ≈ 27×SCALE ≫ HALF_W). The hairpin exit flows straight into the start line with EVEN
  // point spacing — a short/near-duplicate exit segment is what folded earlier versions.
  [-150, -90], [150, -90],              // long start/finish straight (+X)
  [205, -40], [215, 45],                // sweeping right-hander up the east side
  [150, 104], [92, 76], [30, 106],      // chicane across the top (the tightest point on the lap)
  [-62, 104], [-155, 74],               // run to the top-left
  [-208, 8], [-206, -62],               // long left-hand hairpin sweeping back onto the straight
];
// The WHOLE layout scales together so corner radii grow with the road: raising SCALE keeps the
// shape (and the min-radius margin) intact while widening everything, rather than reshaping turns.
const SCALE = 1.6;          // circuit ~1.8k units around — big enough for a wide 8-lane road
const HALF_W = 18;          // road half-width (8 lanes at ±2 … ±14.5; scaled corner radii stay ≫ this)
const CORNER_MIN = 0.7;     // slowest corner speed factor (70% of straight-line)
const EDGE = 0x27e7ff;      // left border neon (cyan)
const EDGE2 = 0xff4dd2;     // right border neon (magenta)

export function createRaceTrack(): RaceTrack {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  const animators: Array<(t: number) => void> = []; // per-frame dressing animations, driven by update()

  // ── shared INK weights (Mario-Kart cartoon lines). One INK multiplier keyed off the global outline
  // scale (0.7 default) so hand-built road ink stays proportional to the shader-puffed car/world
  // outlines. Structure = chunky colored bands with near-black dark rims; neon glow stays an accent. ──
  const INK = inkScale();                 // 0.7 default — coherent with car/world outline thickness
  const INK_DARK = 0x0a0a12;              // near-black ink rim (matches toon OUTLINE_COLOR)
  const EDGE_BAND = 2.4 * INK;            // chunky colored road-edge band width (world units)
  const EDGE_RIM = 0.75 * INK;           // dark ink rim on the road side of each edge band
  const CURB_HW = 1.0 + 0.3 * INK;       // curb half-width (chunkier two-tone chevrons)
  const CURB_RIM = 0.7 * INK;            // dark ink rim on the road side of the curb
  const DASH_HW = 0.55 + 0.35 * INK;     // fat lane-dash half-width
  const RAIL_H = 0.5 + 0.7 * INK;        // thicker barrier top rail
  const RAIL_CAP = 0.3 * INK;            // dark ink cap on top of the rail
  console.info(`[ink] race-track: INK×${INK.toFixed(2)} — edge band ${EDGE_BAND.toFixed(2)}+rim ${EDGE_RIM.toFixed(2)}, curb ±${CURB_HW.toFixed(2)}+rim ${CURB_RIM.toFixed(2)}, dash ±${DASH_HW.toFixed(2)}, rail ${RAIL_H.toFixed(2)}+cap ${RAIL_CAP.toFixed(2)}`);

  const pts = RAW.map(([x, z]) => new THREE.Vector3(x * SCALE, 0, z * SCALE));
  // "centripetal" Catmull-Rom is guaranteed cusp/self-intersection free — uniform ("catmullrom")
  // overshot into a near-cusp (tightest radius ~1.4) that folded the road ribbon.
  const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
  curve.arcLengthDivisions = 3000;
  curve.updateArcLengths();
  const length = curve.getLength();

  // reusable temporaries (poseAt/edgeAt run every frame)
  const _p = new THREE.Vector3();
  const _t = new THREE.Vector3();

  const edgeAt = (u: number, lat: number): [number, number] => {
    const uu = ((u % 1) + 1) % 1;
    curve.getPointAt(uu, _p);
    curve.getTangentAt(uu, _t);
    const l = Math.hypot(_t.x, _t.z) || 1;
    const nx = -_t.z / l, nz = _t.x / l; // left normal in XZ
    return [_p.x + nx * lat, _p.z + nz * lat];
  };

  // densely-sampled centreline for prop-placement clearance checks (self-diagnosing, like the
  // ribbon check): every trackside prop must sit clear of the road, or it warns with the numbers.
  const CLPTS: Array<[number, number]> = [];
  for (let i = 0; i < 480; i++) { curve.getPointAt(i / 480, _p); CLPTS.push([_p.x, _p.z]); }
  const centerlineDist = (x: number, z: number): number => {
    let m = Infinity;
    for (const [px, pz] of CLPTS) { const dx = x - px, dz = z - pz; const d = dx * dx + dz * dz; if (d < m) m = d; }
    return Math.sqrt(m);
  };
  let propWarn = 0, propOk = 0;
  const checkProp = (x: number, z: number, propRadius: number, name: string) => {
    const d = centerlineDist(x, z);
    const need = HALF_W + propRadius + 2;
    if (d < need) { propWarn++; console.warn(`[race-track] prop "${name}" intersects/near road: dist ${d.toFixed(1)} < ${need.toFixed(1)} (HALF_W ${HALF_W} + r ${propRadius} + 2)`); }
    else propOk++;
  };

  // Build-time sanity check (self-diagnosing): every road triangle should face UP and be finite.
  // Catches the winding/NaN class of bug (the road was invisible when tris wound face-down).
  const validateRibbon = (g: THREE.BufferGeometry, name: string) => {
    const pos = g.attributes.position.array as ArrayLike<number>;
    const index = g.getIndex();
    if (!index) return;
    const idx = index.array as ArrayLike<number>;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    let down = 0, nan = 0;
    for (let t = 0; t < idx.length; t += 3) {
      va.fromArray(pos, idx[t] * 3); vb.fromArray(pos, idx[t + 1] * 3); vc.fromArray(pos, idx[t + 2] * 3);
      if ([va, vb, vc].some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z))) { nan++; continue; }
      e1.subVectors(vb, va); e2.subVectors(vc, va); n.crossVectors(e1, e2).normalize();
      if (n.y < 0.5) down++;
    }
    const tris = idx.length / 3;
    if (down || nan) console.warn(`[race-track] ${name}: ${down}/${tris} tris facing not-up (normal.y<0.5), ${nan} NaN tris`);
    else console.info(`[race-track] ${name}: ${tris} tris OK (all face up)`);
  };

  // ---- road ribbon (continuous triangle strip between the two borders). Unlit MeshBasic +
  // DoubleSide so it can never render black or vanish on a winding/normal quirk; winding wound so
  // face normals point UP (validated below). Layered y so nothing z-fights the ground. ----
  const N = 280;
  const solidRibbon = (latOuter: number, latInner: number, y: number, mat: THREE.Material, name?: string) => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const [ax, az] = edgeAt(i / N, latOuter);
      const [bx, bz] = edgeAt(i / N, latInner);
      pos.push(ax, y, az, bx, y, bz);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, c, b, b, c, d); // CCW-from-above → upward face normals
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    if (name) validateRibbon(g, name);
    const m = new THREE.Mesh(g, mat);
    group.add(m);
    return m;
  };

  // decal layers: y-separations scaled up for the big layout AND polygonOffset (progressively more
  // negative per layer) so draw order is offset-driven, not depth-precision-driven → no z-fight.
  const roadMat = keep(new THREE.MeshBasicMaterial({ color: 0x1a1a28, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  solidRibbon(HALF_W, -HALF_W, 0.10, roadMat, "road");
  // chunky cartoon road-edge bands (Mario-Kart borders): a fat colored band on each rim + a near-black
  // ink rim on its road side so the edge reads as a bold outlined curb, not a thin neon line.
  const inkRimMat = keep(new THREE.MeshBasicMaterial({ color: INK_DARK, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
  const bandMat = (hex: number) => keep(new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  solidRibbon(HALF_W, HALF_W - EDGE_BAND, 0.55, bandMat(EDGE));                          // left colored band
  solidRibbon(HALF_W - EDGE_BAND, HALF_W - EDGE_BAND - EDGE_RIM, 0.56, inkRimMat);        // left dark ink rim
  solidRibbon(-(HALF_W - EDGE_BAND), -HALF_W, 0.55, bandMat(EDGE2));                       // right colored band
  solidRibbon(-(HALF_W - EDGE_BAND - EDGE_RIM), -(HALF_W - EDGE_BAND), 0.56, inkRimMat);   // right dark ink rim

  // fat cartoon centre dashes — chunky opaque cream blocks on alternate segments (fewer, fatter)
  {
    const pos: number[] = [];
    const idx: number[] = [];
    let v = 0;
    const DASH = 5;
    for (let i = 0; i < N; i++) {
      if (Math.floor(i / DASH) % 2 === 1) continue;
      const [ax, az] = edgeAt(i / N, DASH_HW);
      const [bx, bz] = edgeAt(i / N, -DASH_HW);
      const [cx, cz] = edgeAt((i + 1) / N, DASH_HW);
      const [dx, dz] = edgeAt((i + 1) / N, -DASH_HW);
      pos.push(ax, 0.25, az, bx, 0.25, bz, cx, 0.25, cz, dx, 0.25, dz);
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); // upward-facing winding (verts: 0,2 left / 1,3 right)
      v += 4;
    }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    group.add(new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ color: 0xffe9a8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))));
  }

  // ---- start pose + gantry + checkered strip (curve param 0 = start/finish line) ----
  curve.getPointAt(0, _p);
  curve.getTangentAt(0, _t);
  const startTL = Math.hypot(_t.x, _t.z) || 1;
  const startPose: TrackPose = {
    x: _p.x, z: _p.z,
    tx: _t.x / startTL, tz: _t.z / startTL,
    rot: Math.atan2(-_t.x / startTL, -_t.z / startTL),
  };
  const sNx = -startPose.tz, sNz = startPose.tx; // start-line lateral normal

  // checkered strip across the road at the line
  const chC = document.createElement("canvas"); chC.width = 256; chC.height = 64;
  const chg = chC.getContext("2d")!;
  const cell = 32;
  for (let cxi = 0; cxi < 256 / cell; cxi++) for (let cyi = 0; cyi < 64 / cell; cyi++) {
    chg.fillStyle = (cxi + cyi) % 2 === 0 ? "#e9eefc" : "#0c0b18";
    chg.fillRect(cxi * cell, cyi * cell, cell, cell);
  }
  const chTex = keep(new THREE.CanvasTexture(chC));
  const checker = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(2 * HALF_W, 8)),
    keep(new THREE.MeshBasicMaterial({ map: chTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 })),
  );
  checker.rotation.x = -Math.PI / 2;
  const chGroup = new THREE.Group();
  chGroup.add(checker);
  chGroup.position.set(startPose.x, 0.70, startPose.z);
  chGroup.rotation.y = Math.atan2(-sNz, sNx);
  group.add(chGroup);

  // gantry arch over the straight, with an animated scrolling banner + vertical light beams
  const gantryMat = keep(new THREE.MeshStandardMaterial({ color: 0x141026, emissive: EDGE, emissiveIntensity: 0.8 }));
  const bannerAngle = Math.atan2(-sNz, sNx);
  const GH = 9; // gantry height
  const postGeo = keep(new THREE.BoxGeometry(1.4, GH, 1.4));
  const [lx, lz] = [startPose.x + sNx * HALF_W, startPose.z + sNz * HALF_W];
  const [rx, rz] = [startPose.x - sNx * HALF_W, startPose.z - sNz * HALF_W];
  const postL = new THREE.Mesh(postGeo, gantryMat); postL.position.set(lx, GH / 2, lz); group.add(postL);
  const postR = new THREE.Mesh(postGeo, gantryMat); postR.position.set(rx, GH / 2, rz); group.add(postR);
  const beam = new THREE.Mesh(keep(new THREE.BoxGeometry(2 * HALF_W + 2.8, 1.5, 1.5)), gantryMat);
  beam.position.set(startPose.x, GH, startPose.z);
  beam.rotation.y = bannerAngle;
  group.add(beam);
  // scrolling banner under the beam
  const bannerTex = keep(new THREE.CanvasTexture(makeBannerTexture()));
  bannerTex.wrapS = THREE.RepeatWrapping; bannerTex.repeat.x = 2;
  const banner = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(2 * HALF_W + 2, 2.4)),
    keep(new THREE.MeshBasicMaterial({ map: bannerTex, transparent: true, side: THREE.DoubleSide })),
  );
  banner.position.set(startPose.x, GH - 2.2, startPose.z);
  banner.rotation.y = bannerAngle;
  group.add(banner);
  animators.push((tt) => { bannerTex.offset.x = (tt * 0.06) % 1; });
  // two vertical light beams shooting up from the posts
  const beamGeo = keep(new THREE.CylinderGeometry(0.9, 2.4, 60, 12, 1, true));
  for (const [bxp, bzp] of [[lx, lz], [rx, rz]] as [number, number][]) {
    const beamMat = keep(new THREE.MeshBasicMaterial({
      color: 0x9fe0ff, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const lb = new THREE.Mesh(beamGeo, beamMat);
    lb.position.set(bxp, GH + 30, bzp);
    group.add(lb);
    animators.push((tt) => { beamMat.opacity = 0.11 + 0.06 * (0.5 + 0.5 * Math.sin(tt * 1.6 + bxp)); });
  }

  // ---- ground plane + neon grid ----
  const bx = new THREE.Box3().setFromPoints(pts);
  const center = bx.getCenter(new THREE.Vector3()); center.y = 0;
  const size = bx.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) * 0.5 + HALF_W;

  // "wet asphalt": dark charcoal that stays dark from EVERY angle. The env-mapped gloss was
  // fresnel-spiking to a white-hot plane at grazing incidence — so metalness is near-zero, roughness
  // high, and envMapIntensity crushed. The wet-neon look comes ONLY from the mirrored reflection
  // meshes reading through the slightly-transparent surface, not from env-map sheen.
  const groundMat = keep(new THREE.MeshStandardMaterial({ color: 0x07050c, metalness: 0.04, roughness: 0.72, transparent: true, opacity: 0.85 }));
  groundMat.envMapIntensity = 0.06; // near-zero env sheen — the wet look is the mirrored reflections, not this
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(3200, 3200)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, -0.05, center.z);
  group.add(ground);

  const grid = new THREE.GridHelper(2400, 90, 0xff4dd2, 0x3a2a7a);
  const gm = grid.material as THREE.LineBasicMaterial;
  gm.transparent = true; gm.opacity = 0.22; gm.depthWrite = false;
  grid.position.set(center.x, -0.02, center.z); // just above ground, below the road ribbon
  group.add(grid);

  // floodlight towers with soft additive light cones angled onto the track
  const poleMat = keep(new THREE.MeshBasicMaterial({ color: 0x171326 }));
  const headMat = keep(new THREE.MeshBasicMaterial({ color: 0xeaf6ff }));
  const poleGeo = keep(new THREE.BoxGeometry(1.2, 34, 1.2));
  const headGeo = keep(new THREE.BoxGeometry(7, 2, 3));
  // cone tall/wide for the big track; a per-vertex brightness gradient (bright at the apex/source,
  // black at the wide base) makes it read as light instead of a solid grey megaphone.
  const CONE_H = 40;
  const coneGeo = keep(new THREE.ConeGeometry(20, CONE_H, 24, 1, true));
  {
    const cp = coneGeo.attributes.position;
    const cc = new Float32Array(cp.count * 3);
    for (let i = 0; i < cp.count; i++) {
      const tt = (cp.getY(i) + CONE_H / 2) / CONE_H;     // 0 base → 1 apex
      const b = Math.pow(Math.max(0, tt), 1.6);          // bright only near the source
      cc[i * 3] = b; cc[i * 3 + 1] = b; cc[i * 3 + 2] = b;
    }
    coneGeo.setAttribute("color", new THREE.Float32BufferAttribute(cc, 3));
  }
  const towerSpots: [number, number][] = [
    [bx.min.x - 40, bx.min.z - 40], [bx.max.x + 40, bx.min.z - 34],
    [bx.min.x - 34, bx.max.z + 40], [bx.max.x + 40, bx.max.z + 40],
    [center.x, bx.min.z - 52],
  ];
  const _up = new THREE.Vector3(0, 1, 0);
  const TH = 34; // tower height
  towerSpots.forEach(([fx, fz], ti) => {
    checkProp(fx, fz, 3, `floodlight ${ti + 1}`);
    const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(fx, TH / 2, fz); group.add(pole);
    const head = new THREE.Mesh(headGeo, headMat); head.position.set(fx, TH + 0.5, fz);
    head.lookAt(center.x, 0, center.z); group.add(head);
    // additive cone from the head down toward a point on the track apron
    const tgt = new THREE.Vector3(center.x * 0.55 + fx * 0.2, 0, center.z * 0.55 + fz * 0.2);
    const from = new THREE.Vector3(fx, TH, fz);
    const dir = new THREE.Vector3().subVectors(from, tgt).normalize(); // cone +Y (apex) points at the head
    const coneMat = keep(new THREE.MeshBasicMaterial({
      vertexColors: true, color: 0xcfe6ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.quaternion.setFromUnitVectors(_up, dir);
    cone.position.copy(from).addScaledVector(dir, -CONE_H / 2); // apex sits at the head
    group.add(cone);
    animators.push((tt) => { coneMat.opacity = 0.06 + 0.02 * Math.sin(tt * 3 + fx); });
  });

  // ---- cornering table: curvature → speed factor, precomputed at high resolution ----
  const K = 720;
  const ang = new Float32Array(K);
  for (let i = 0; i < K; i++) { curve.getTangentAt(i / K, _t); ang[i] = Math.atan2(_t.z, _t.x); }
  const rawCurv = new Float32Array(K);
  const sgn = new Float32Array(K); // +1 left turn / -1 right turn — inner (concave) side of the corner
  const ds = length / K;
  for (let i = 0; i < K; i++) {
    let d = ang[(i + 1) % K] - ang[i];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    rawCurv[i] = Math.abs(d) / ds;
    sgn[i] = d >= 0 ? 1 : -1;
  }
  // box-smooth the curvature so the factor eases in/out of corners (not spiky)
  const curv = new Float32Array(K);
  const W = 6;
  let maxCurv = 1e-6, tightIdx = 0;
  for (let i = 0; i < K; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += rawCurv[((i + k) % K + K) % K];
    curv[i] = sum / (2 * W + 1);
    if (curv[i] > maxCurv) { maxCurv = curv[i]; tightIdx = i; }
  }
  const factor = new Float32Array(K);
  for (let i = 0; i < K; i++) factor[i] = 1 - (1 - CORNER_MIN) * Math.min(1, curv[i] / maxCurv);
  const tightestTurnS = (tightIdx / K) * length;

  // self-diagnosing fold check: if the tightest radius of curvature < HALF_W the inner edge folds
  let maxRaw = 1e-6;
  for (let i = 0; i < K; i++) if (rawCurv[i] > maxRaw) maxRaw = rawCurv[i];
  const minRadius = 1 / maxRaw;
  if (minRadius < HALF_W) console.warn(`[race-track] tightest radius ${minRadius.toFixed(1)} < HALF_W ${HALF_W} → inner edge folds; widen the turn or shrink HALF_W`);
  else console.info(`[race-track] tightest radius ${minRadius.toFixed(1)} ≥ HALF_W ${HALF_W} (no fold)`);

  // ---- corner apexes (local maxima of curvature) → drive turn signs, apex lights, apex cams ----
  const corners: number[] = [];
  {
    const thresh = maxCurv * 0.4;
    for (let i = 0; i < K; i++) {
      if (curv[i] < thresh) continue;
      let isMax = true;
      for (let k = -12; k <= 12; k++) if (curv[((i + k) % K + K) % K] > curv[i] + 1e-9) { isMax = false; break; }
      if (isMax) {
        const s = (i / K) * length;
        if (!corners.some((cs) => Math.abs(cs - s) < length * 0.06)) corners.push(s);
      }
    }
    corners.sort((a, b) => a - b);
  }

  // ---- racing curbs: chunky two-tone magenta/white chevrons + a near-black ink rim on the road side
  // of every turn's inner edge (one merged mesh, DoubleSide so winding is free) ----
  {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    let v = 0;
    const curbThresh = maxCurv * 0.25;
    const magenta = [1.0, 0.30, 0.82], white = [0.92, 0.96, 1.0], dark = [0.04, 0.04, 0.07];
    const quad = (u0: number, u1: number, latA: number, latB: number, c: number[]) => {
      const [ax, az] = edgeAt(u0, latA), [bx2, bz2] = edgeAt(u0, latB);
      const [cx, cz] = edgeAt(u1, latA), [dx, dz] = edgeAt(u1, latB);
      pos.push(ax, 0.40, az, bx2, 0.40, bz2, cx, 0.40, cz, dx, 0.40, dz);
      for (let q = 0; q < 4; q++) col.push(c[0], c[1], c[2]);
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    };
    for (let i = 0; i < K; i++) {
      if (curv[i] < curbThresh) continue;
      const lat = sgn[i] * (HALF_W - 0.6);   // inner (concave) edge of the turn
      const c = (Math.floor(i / 2) % 2 === 0) ? magenta : white;
      quad(i / K, (i + 1) / K, lat - CURB_HW, lat + CURB_HW, c);                             // chunky two-tone curb
      const rimOut = lat - sgn[i] * CURB_HW; // road-side edge of the curb
      quad(i / K, (i + 1) / K, rimOut, rimOut - sgn[i] * CURB_RIM, dark);                    // dark ink rim on the road side
    }
    if (v) {
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      group.add(new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }))));
    }
  }

  // ---- barrier walls: PLAIN dark walls with a neon top rail (no text on the wall), plus DISCRETE
  // sponsor board planes. Each board is a standard PlaneGeometry (default UVs) oriented with lookAt
  // — a front twin facing the track + a back twin facing outward, exactly like the turn signs.
  // Default-UV + lookAt cannot mirror text (no arclen / tangent / winding math left to get wrong).
  // Boards are grouped per sponsor texture into InstancedMeshes to keep draw calls low. ----
  const WALL_LAT = HALF_W + 2, WALL_H = 2.6;
  const SPONSORS: Array<[string, string]> = [
    ["OCTANE", "#27e7ff"], ["PERPS", "#ff4dd2"], ["VRF VERIFIED", "#41d67f"],
    ["SCRAPYARD", "#ffb020"], ["CRATES", "#b06bff"],
  ];
  const wallMat = keep(new THREE.MeshBasicMaterial({ color: 0x0a0713, side: THREE.DoubleSide }));
  const railCapMat = keep(new THREE.MeshBasicMaterial({ color: INK_DARK, side: THREE.DoubleSide })); // dark ink top edge
  const buildWall = (side: 1 | -1, railColor: number) => {
    const wp: number[] = [], wi: number[] = [], rp: number[] = [], rii: number[] = [], cp: number[] = [], ci: number[] = [];
    for (let i = 0; i <= N; i++) {
      const [x, z] = edgeAt(i / N, side * WALL_LAT);
      wp.push(x, 0.1, z, x, WALL_H, z);
      rp.push(x, WALL_H, z, x, WALL_H + RAIL_H, z);                       // thick colored top rail
      cp.push(x, WALL_H + RAIL_H, z, x, WALL_H + RAIL_H + RAIL_CAP, z);   // dark ink cap above it
    }
    for (let i = 0; i < N; i++) { const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3; wi.push(a, c, b, b, c, d); rii.push(a, c, b, b, c, d); ci.push(a, c, b, b, c, d); }
    const wg = keep(new THREE.BufferGeometry()); wg.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3)); wg.setIndex(wi);
    group.add(new THREE.Mesh(wg, wallMat)); // DoubleSide dark — no text, nothing to mirror
    const rg = keep(new THREE.BufferGeometry()); rg.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3)); rg.setIndex(rii);
    group.add(new THREE.Mesh(rg, keep(new THREE.MeshBasicMaterial({ color: railColor, side: THREE.DoubleSide, toneMapped: false }))));
    const cg = keep(new THREE.BufferGeometry()); cg.setAttribute("position", new THREE.Float32BufferAttribute(cp, 3)); cg.setIndex(ci);
    group.add(new THREE.Mesh(cg, railCapMat));
  };
  buildWall(1, EDGE); buildWall(-1, EDGE2);

  // discrete sponsor boards — front + back twins, grouped per texture → 5 instanced meshes
  const boardMats = SPONSORS.map(([label, col]) => keep(new THREE.MeshBasicMaterial({ map: keep(new THREE.CanvasTexture(makeBoardTexture(label, col))), side: THREE.FrontSide, toneMapped: false })));
  const boardMatrices: THREE.Matrix4[][] = SPONSORS.map(() => []);
  const BOARD_H = WALL_H * 0.8, SPACING = 48, MAXW = 34;
  const dummyB = new THREE.Object3D();
  let stations = 0;
  const placeBoards = (side: 1 | -1, startSponsor: number) => {
    const M = 800;
    let acc = 0, px = 0, pz = 0, have = false, nextAt = SPACING * 0.5, sIdx = startSponsor;
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      const [x, z] = edgeAt(u, side * WALL_LAT);
      if (have) acc += Math.hypot(x - px, z - pz);
      px = x; pz = z; have = true;
      if (acc < nextAt) continue;
      nextAt += SPACING;
      stations++;
      // shrink the board near tight curvature so a flat plane doesn't clip the curved wall; skip if tiny
      const radius = 1 / Math.max(curv[Math.floor(u * K) % K], 1e-4);
      const bw = Math.min(MAXW, Math.sqrt(6.4 * radius));
      if (bw < 9) { sIdx++; continue; }
      const [cxp, czp] = edgeAt(u, 0); // centreline point at this arc
      let inx = cxp - x, inz = czp - z; const il = Math.hypot(inx, inz) || 1; inx /= il; inz /= il; // inward dir
      const s = ((sIdx % SPONSORS.length) + SPONSORS.length) % SPONSORS.length;
      const cy = BOARD_H / 2 + 0.25;
      // front twin — +Z (textured face) toward the track; back twin — +Z toward outside
      dummyB.position.set(x + inx * 0.2, cy, z + inz * 0.2); dummyB.lookAt(x + inx * 1.2, cy, z + inz * 1.2);
      dummyB.scale.set(bw, BOARD_H, 1); dummyB.updateMatrix(); boardMatrices[s].push(dummyB.matrix.clone());
      dummyB.position.set(x - inx * 0.2, cy, z - inz * 0.2); dummyB.lookAt(x - inx * 1.2, cy, z - inz * 1.2);
      dummyB.scale.set(bw, BOARD_H, 1); dummyB.updateMatrix(); boardMatrices[s].push(dummyB.matrix.clone());
      sIdx++;
    }
  };
  placeBoards(1, 0); placeBoards(-1, 2); // offset the sponsor cycle so the two walls don't line up
  const boardPlane = keep(new THREE.PlaneGeometry(1, 1));
  boardMatrices.forEach((mats, s) => {
    if (!mats.length) return;
    const im = new THREE.InstancedMesh(boardPlane, boardMats[s], mats.length);
    for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
  });
  const boardPlanes = boardMatrices.reduce((a, m) => a + m.length, 0);
  console.info(`[race-track] barrier boards: ${stations} stations/2-walls, ${boardPlanes} discrete planes across ${SPONSORS.length} instanced meshes`);

  // ---- turn-number signs + blinking apex marker lights at each corner ----
  const apexLights: THREE.Mesh[] = [];
  const amberSign = "#ffd166";
  corners.forEach((s, ci) => {
    const u = (s % length) / length;
    curve.getPointAt(u, _p); curve.getTangentAt(u, _t);
    const l = Math.hypot(_t.x, _t.z) || 1; const tx = _t.x / l, tz = _t.z / l;
    const nx = -tz, nz = tx;
    const inner = sgn[Math.floor(u * K) % K]; // +left / -right
    // turn sign on a post OUTSIDE the corner (clear of the barrier), facing the track centre
    const ox = _p.x - nx * inner * (WALL_LAT + 6), oz = _p.z - nz * inner * (WALL_LAT + 6);
    checkProp(ox, oz, 2.5, `sign T${ci + 1}`);
    const signMat = keep(new THREE.MeshBasicMaterial({ map: keep(new THREE.CanvasTexture(makeSignTexture(`T${ci + 1}`, amberSign))), transparent: true, side: THREE.FrontSide }));
    const signPost = new THREE.Mesh(keep(new THREE.BoxGeometry(0.5, 8, 0.5)), poleMat);
    signPost.position.set(ox, 4, oz); group.add(signPost);
    // two single-sided faces (front toward centre, back toward outside) so "T#" never reads
    // mirrored — each face shows the texture un-mirrored from its own viewing side.
    const signGeo = keep(new THREE.PlaneGeometry(5, 5));
    const signFront = new THREE.Mesh(signGeo, signMat);
    signFront.position.set(ox, 9, oz); signFront.lookAt(center.x, 9, center.z); group.add(signFront);
    const signBack = new THREE.Mesh(signGeo, signMat);
    signBack.position.set(ox, 9, oz); signBack.lookAt(2 * ox - center.x, 9, 2 * oz - center.z); group.add(signBack);
    // apex marker light on the inner curb
    const apx = _p.x + nx * inner * (HALF_W - 0.6), apz = _p.z + nz * inner * (HALF_W - 0.6);
    const apexMat = keep(new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    const apex = new THREE.Mesh(keep(new THREE.SphereGeometry(0.6, 10, 10)), apexMat);
    apex.position.set(apx, 0.7, apz); group.add(apex);
    apexLights.push(apex);
  });
  animators.push((tt) => { for (let i = 0; i < apexLights.length; i++) apexLights[i].scale.setScalar(0.6 + 0.5 * (0.5 + 0.5 * Math.sin(tt * 5 + i * 1.3))); });

  // ---- grandstand OUTSIDE the start straight (dark block + crowd phone-lights as Points) ----
  {
    const sTx = startPose.tx, sTz = startPose.tz;
    const standAngle = Math.atan2(-sTz, sTx);
    // place it on the OUTWARD side of the straight (away from the infield), not on the track
    const outSign = (sNx * (startPose.x - center.x) + sNz * (startPose.z - center.z)) >= 0 ? 1 : -1;
    const off = outSign * (WALL_LAT + 16);
    const baseX = startPose.x - sTx * 20 + sNx * off;
    const baseZ = startPose.z - sTz * 20 + sNz * off;
    checkProp(baseX, baseZ, 7, "grandstand");
    const stand = new THREE.Mesh(keep(new THREE.BoxGeometry(60, 16, 12)), keep(new THREE.MeshBasicMaterial({ color: 0x0c0a1a })));
    stand.position.set(baseX, 8, baseZ); stand.rotation.y = standAngle; group.add(stand);
    const CN = 320;
    const cpos = new Float32Array(CN * 3), ccol = new Float32Array(CN * 3);
    const pal = [new THREE.Color(0x27e7ff), new THREE.Color(0xff4dd2), new THREE.Color(0xffd166), new THREE.Color(0xffffff)];
    const faceDir = -outSign; // crowd looks toward the track
    for (let i = 0; i < CN; i++) {
      const along = (Math.random() - 0.5) * 58, up = 3 + Math.random() * 11;
      cpos[i * 3] = baseX + sTx * along + sNx * faceDir * 6.2;
      cpos[i * 3 + 1] = up;
      cpos[i * 3 + 2] = baseZ + sTz * along + sNz * faceDir * 6.2;
      const c = pal[i % pal.length];
      ccol[i * 3] = c.r; ccol[i * 3 + 1] = c.g; ccol[i * 3 + 2] = c.b;
    }
    const cg = keep(new THREE.BufferGeometry());
    cg.setAttribute("position", new THREE.BufferAttribute(cpos, 3));
    cg.setAttribute("color", new THREE.BufferAttribute(ccol, 3));
    const cMat = keep(new THREE.PointsMaterial({ size: 0.85, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(new THREE.Points(cg, cMat));
    animators.push((tt) => { cMat.opacity = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(tt * 8)); });
  }

  // (the surrounding world — 3D city, billboards, sky dome, moon, reflections — is built by the
  // separate race-environment.ts module so the track file stays about the circuit itself.)
  const boundingRadius = 0.5 * Math.hypot(size.x, size.z) + HALF_W;

  if (propWarn === 0) console.info(`[race-track] props OK: ${propOk} trackside props clear of the road`);

  // cel-shade the circuit SOLIDS — the gantry structure + ground pick up outlines/toon banding; the
  // MeshBasic road ribbons, kerbs, banners, sponsor boards and lamp heads are left to bloom/read flat.
  const toonStats = toonifyWorld(group, { outlineWidth: 0.3, outlineMinSize: 4 });
  console.info(`[toon] race-track: ${toonStats.toonMats} toon mats, ${toonStats.hulls} outline hulls`);

  let t = 0;
  return {
    group,
    curve,
    length,
    poseAt(s, lateral) {
      const u = ((s % length) / length + 1) % 1;
      curve.getPointAt(u, _p);
      curve.getTangentAt(u, _t);
      const l = Math.hypot(_t.x, _t.z) || 1;
      const tx = _t.x / l, tz = _t.z / l;
      const nx = -tz, nz = tx;
      return { x: _p.x + nx * lateral, z: _p.z + nz * lateral, rot: Math.atan2(-tx, -tz), tx, tz };
    },
    cornerFactorAt(s) {
      const u = ((s % length) / length + 1) % 1;
      const f = u * K;
      const i0 = Math.floor(f) % K;
      const i1 = (i0 + 1) % K;
      const frac = f - Math.floor(f);
      return factor[i0] * (1 - frac) + factor[i1] * frac;
    },
    tightestTurnS,
    corners,
    center,
    radius,
    boundingRadius,
    distanceToCenterline: centerlineDist,
    startPose,
    update(dt) {
      t += dt;
      gantryMat.emissiveIntensity = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2));
      for (const a of animators) a(t);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
