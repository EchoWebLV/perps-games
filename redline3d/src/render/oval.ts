import * as THREE from "three";
import { TRACK, LEN, sample, elevationAt, progress } from "../core/track";
import { toonifyWorld } from "./toon";

// Highway oval v2 (spec 2026-07-02): a 3-lane-per-carriageway divided highway on
// the 3× track. The road follows elevationAt(s) — a rolling synthwave causeway
// over a flat neon ground plane — under a hardcoded synthwave backdrop (gradient
// sky dome, striped retro sun, low-poly mountain ring, star field) so the
// horizon reads magenta/purple instead of black. Palette cribbed from world.ts.

export interface OvalRemoteCar { id: string; x: number; z: number; heading: number; dir: 1 | -1 | 0 }

export interface Oval {
  group: THREE.Group;
  show(): void;
  hide(): void;
  /** ghost cars (Phase 2 presence feeds this; [] today) */
  setRemoteCars(states: OvalRemoteCar[]): void;
  /** trackside billboard text (asset + live price) — cheap CanvasTexture redraw */
  setBillboard(line1: string, line2: string): void;
  update(dt: number): void;
  dispose(): void;
}

const { R, MEDIAN_HALF, EDGE } = TRACK;

/** a ribbon between two lateral offsets, sampled along the whole loop. It rides
 *  the road elevation: y is a layer OFFSET above the surface, not an absolute height. */
function ribbonGeometry(latA: number, latB: number, y: number, step = 4): THREE.BufferGeometry {
  const n = Math.ceil(LEN / step);
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * LEN;
    const c = sample(s);
    const ey = elevationAt(s) + y;
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    pos.push(c.x + rx * latA, ey, c.z + rz * latA, c.x + rx * latB, ey, c.z + rz * latB);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createOval(): Oval {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // ground + neon grid (same palette as the lobby lot) — flat at y≈0; the road
  // rises above it on the hills (intended elevated-causeway look)
  const groundGeo = track(new THREE.PlaneGeometry(2600, 2000));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  group.add(ground);
  const grid = track(new THREE.GridHelper(2000, 200, 0xff4dd2, 0x6a2bd9));
  const gm = grid.material as THREE.Material & { opacity: number };
  gm.transparent = true; gm.opacity = 0.28;
  grid.position.y = -0.02;
  group.add(grid);

  // ── synthwave backdrop (fog: false — it lives far past the scene fog) ─────
  // deterministic placement: a tiny seeded PRNG (mulberry32) instead of Math.random
  // so the mountain/star arrangement is identical every load (stable visual diffs)
  let prngState = 0x7f4a7c15;
  const rand = () => {
    prngState = (prngState + 0x6d2b79f5) | 0;
    let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // sky dome: deep purple up top → magenta glow near the horizon.
  // INVARIANT: the dome radius (1400) must stay LARGER than the distance of every
  // backdrop prop it encloses — striped sun (z≈−1150), mountain ring (≤1250),
  // stars (≤1300) — or they'd poke outside / be swallowed by the dome. All of
  // these live far beyond the scene fog (which fully fades at 420), so every
  // backdrop material sets fog:false; without it they'd render as flat fog color.
  const skyGeo = track(new THREE.SphereGeometry(1400, 24, 12));
  const skyMat = track(new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false,
    uniforms: { top: { value: new THREE.Color("#14052e") }, bot: { value: new THREE.Color("#8e2468") } },
    vertexShader: `varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `varying float h; uniform vec3 top; uniform vec3 bot; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(h*1.4+0.3,0.0,1.0)), 1.0);} `,
  }));
  group.add(new THREE.Mesh(skyGeo, skyMat));

  // striped retro sun: one flat disc low over the north end; a tiny shader does
  // the warm gradient + discards horizontal slit bands across the lower half
  const SUN_R = 140;
  const sunGeo = track(new THREE.CircleGeometry(SUN_R, 48));
  const sunMat = track(new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color("#ffdf6e") },
      uMid: { value: new THREE.Color("#ff6a3c") },
      uBot: { value: new THREE.Color("#ff2d7a") },
    },
    vertexShader: `varying float t; void main(){ t = position.y / ${SUN_R.toFixed(1)} * 0.5 + 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying float t; uniform vec3 uTop, uMid, uBot;
      void main(){
        if (t < 0.55 && fract(t * 7.0) < 0.35) discard; // ~4 slit gaps, lower half
        vec3 col = t < 0.5 ? mix(uBot, uMid, t * 2.0) : mix(uMid, uTop, t * 2.0 - 1.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  const sun = new THREE.Mesh(sunGeo, sunMat);
  sun.position.set(0, 60, -1150); // default plane faces +z = back toward the track
  group.add(sun);

  // mountain ring: low-poly cones in two dark-purple shades, silhouetted on the horizon
  const mtnGeo = track(new THREE.ConeGeometry(1, 1, 5));
  const mtnMatA = track(new THREE.MeshBasicMaterial({ color: 0x1d0b3d, fog: false }));
  const mtnMatB = track(new THREE.MeshBasicMaterial({ color: 0x2c1257, fog: false }));
  const MTN_N = 18;
  for (let i = 0; i < MTN_N; i++) {
    const a = (i / MTN_N) * Math.PI * 2 + (rand() - 0.5) * 0.25;
    const rr = 1000 + rand() * 250;
    const h = 60 + rand() * 100;
    const rad = 70 + rand() * 90;
    const m = new THREE.Mesh(mtnGeo, i % 2 ? mtnMatA : mtnMatB);
    m.scale.set(rad, h, rad);
    m.position.set(Math.cos(a) * rr, h / 2 - 2, Math.sin(a) * rr);
    m.rotation.y = rand() * Math.PI;
    group.add(m);
  }

  // stars: sparse points scattered on the upper sky shell (inside the dome)
  const starGeo = track(new THREE.BufferGeometry());
  const STAR_N = 420;
  const sp = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    const th = rand() * Math.PI * 2;
    const u = 0.18 + rand() * 0.75; // sin(elevation) → y stays above ~200
    const rr = 1100 + rand() * 200;
    const horiz = Math.sqrt(1 - u * u) * rr;
    sp[i * 3] = Math.cos(th) * horiz;
    sp[i * 3 + 1] = u * rr;
    sp[i * 3 + 2] = Math.sin(th) * horiz;
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  // sizeAttenuation OFF: constant pixel size, so stars don't balloon when the
  // camera nears the dome. size retuned 3.2→1.6 to match the old attenuated look.
  const starMat = track(new THREE.PointsMaterial({ color: 0xd6ecff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
  group.add(new THREE.Points(starGeo, starMat));

  // ── the road ────────────────────────────────────────────────────────────
  // asphalt: both carriageways in one ribbon (median sits on top)
  const roadMat = track(new THREE.MeshStandardMaterial({ color: 0x0d0d1f, metalness: 0.3, roughness: 0.7 }));
  group.add(new THREE.Mesh(track(ribbonGeometry(-EDGE, EDGE, 0)), roadMat));

  // raised median + its amber edge lines (the hard barrier down the middle)
  const medianMat = track(new THREE.MeshStandardMaterial({ color: 0x1a1133, emissive: 0xffb02e, emissiveIntensity: 0.12 }));
  const median = new THREE.Mesh(track(ribbonGeometry(-MEDIAN_HALF, MEDIAN_HALF, 0.22)), medianMat);
  group.add(median);
  const amberMat = track(new THREE.MeshBasicMaterial({ color: 0xffb02e }));
  group.add(new THREE.Mesh(track(ribbonGeometry(-MEDIAN_HALF - 0.35, -MEDIAN_HALF, 0.24)), amberMat));
  group.add(new THREE.Mesh(track(ribbonGeometry(MEDIAN_HALF, MEDIAN_HALF + 0.35, 0.24)), amberMat));

  // outer edge lines (cyan) on both sides
  const cyanMat = track(new THREE.MeshBasicMaterial({ color: 0x2de2e6 }));
  group.add(new THREE.Mesh(track(ribbonGeometry(EDGE - 0.35, EDGE, 0.03)), cyanMat));
  group.add(new THREE.Mesh(track(ribbonGeometry(-EDGE, -EDGE + 0.35, 0.03)), cyanMat));

  // dashed lane dividers: LANES lanes per carriageway → LANES−1 dash rings per
  // side at lat ±(MEDIAN_HALF + k·LANE_W), riding the road elevation
  const dashMat = track(new THREE.MeshBasicMaterial({ color: 0x9ad7ff }));
  const dashGeo = track(new THREE.PlaneGeometry(0.35, 3));
  const laneRings = TRACK.LANES - 1;
  const dashCount = Math.floor(LEN / 9);
  const dashes = track(new THREE.InstancedMesh(dashGeo, dashMat, dashCount * 2 * laneRings));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const flatQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const one = new THREE.Vector3(1, 1, 1);
  let di = 0;
  for (let i = 0; i < dashCount; i++) {
    const s = (i / dashCount) * LEN;
    const c = sample(s);
    const ey = elevationAt(s);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (let lane = 1; lane <= laneRings; lane++) {
      const laneLat = MEDIAN_HALF + lane * TRACK.LANE_W;
      for (const side of [1, -1]) {
        // plane lies flat (rotated −90° around X), long axis along the travel direction
        q.setFromAxisAngle(up, -c.heading).multiply(flatQ);
        m4.compose(new THREE.Vector3(c.x + rx * laneLat * side, ey + 0.03, c.z + rz * laneLat * side), q, one);
        dashes.setMatrixAt(di++, m4);
      }
    }
  }
  group.add(dashes);

  // outer barrier: low glowing wall segments (instanced), like the lobby's perimeter
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeo = track(new THREE.BoxGeometry(0.6, 1.6, 6.4));
  const wallCount = Math.floor(LEN / 6);
  const walls = track(new THREE.InstancedMesh(wallGeo, wallMat, wallCount * 2));
  let wi = 0;
  for (let i = 0; i < wallCount; i++) {
    const s = (i / wallCount) * LEN;
    const c = sample(s);
    const ey = elevationAt(s);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      q.setFromAxisAngle(up, -c.heading);
      m4.compose(new THREE.Vector3(c.x + rx * (EDGE + 0.6) * side, ey + 0.8, c.z + rz * (EDGE + 0.6) * side), q, one);
      walls.setMatrixAt(wi++, m4);
    }
  }
  group.add(walls);

  // lamp posts every ~96m outside the barrier: violet pole + magenta bar (emissive
  // only) — instanced like the dashes/walls: one draw for all poles + one for all bars
  const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x160f2e, emissive: 0x5a3fd6, emissiveIntensity: 0.8 }));
  const barMat = track(new THREE.MeshStandardMaterial({ color: 0x2a0f24, emissive: 0xff2d95, emissiveIntensity: 1.6 }));
  const poleGeo = track(new THREE.CylinderGeometry(0.18, 0.18, 7, 6));
  const barGeo = track(new THREE.BoxGeometry(2.6, 0.28, 0.28));
  const lampCount = Math.floor(LEN / 96);
  const poles = track(new THREE.InstancedMesh(poleGeo, poleMat, lampCount * 2));
  const bars = track(new THREE.InstancedMesh(barGeo, barMat, lampCount * 2));
  const noRot = new THREE.Quaternion();
  let li = 0;
  for (let i = 0; i < lampCount; i++) {
    const s = (i / lampCount) * LEN;
    const c = sample(s);
    const ey = elevationAt(s);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      const px = c.x + rx * (EDGE + 3.4) * side, pz = c.z + rz * (EDGE + 3.4) * side;
      m4.compose(new THREE.Vector3(px, ey + 3.5, pz), noRot, one);
      poles.setMatrixAt(li, m4);
      q.setFromAxisAngle(up, -c.heading); // bar faces across the road, like bar.rotation.y = -heading
      m4.compose(new THREE.Vector3(px, ey + 7.1, pz), q, one);
      bars.setMatrixAt(li++, m4);
    }
  }
  group.add(poles, bars);

  // trackside price billboard (east straight, outside the barrier)
  const bbCanvas = document.createElement("canvas");
  bbCanvas.width = 512; bbCanvas.height = 256;
  const bbTex = track(new THREE.CanvasTexture(bbCanvas));
  const drawBillboard = (l1: string, l2: string) => {
    const g = bbCanvas.getContext("2d")!;
    g.fillStyle = "#0c0a18"; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = "#2de2e6"; g.lineWidth = 8; g.strokeRect(6, 6, 500, 244);
    g.textAlign = "center"; g.font = "700 72px 'Chakra Petch', ui-monospace, monospace";
    g.fillStyle = "#2de2e6"; g.fillText(l1, 256, 104, 492);
    g.fillStyle = "#35ff9d"; g.fillText(l2, 256, 200, 492);
    bbTex.needsUpdate = true;
  };
  drawBillboard("PERPS", "RAIDER");
  const bbMat = track(new THREE.MeshBasicMaterial({ map: bbTex }));
  const bbGeo = track(new THREE.PlaneGeometry(33, 16.5));
  const bb = new THREE.Mesh(bbGeo, bbMat);
  bb.position.set(R + EDGE + 25, 12, 60);
  bb.rotation.y = -Math.PI / 2; // face the east straight (toward −x)
  group.add(bb);
  const bbPoleGeo = track(new THREE.CylinderGeometry(0.5, 0.5, 10.5, 6));
  for (const dz of [-12, 12]) {
    const p = new THREE.Mesh(bbPoleGeo, poleMat); p.position.set(R + EDGE + 25, 5.25, 60 + dz); group.add(p);
  }

  // ambient fill (the lobby does the same)
  group.add(new THREE.AmbientLight(0x6a4cff, 0.5));

  // ghost cars — same shape as the lobby seam, tinted by direction
  const remoteGroup = new THREE.Group(); group.add(remoteGroup);
  const remoteMap = new Map<string, THREE.Mesh>();
  const remoteGeo = track(new THREE.BoxGeometry(3.6, 1.6, 7));
  const matLong = track(new THREE.MeshStandardMaterial({ color: 0x11261c, emissive: 0x35ff9d, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
  const matShort = track(new THREE.MeshStandardMaterial({ color: 0x2a0f1c, emissive: 0xff5a7a, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
  const matIdle = track(new THREE.MeshStandardMaterial({ color: 0x222233, emissive: 0x4da6ff, emissiveIntensity: 0.4, transparent: true, opacity: 0.85 }));
  remoteGroup.userData.toonSkip = true; // ghost cars are dynamic presentation boxes — leave them

  // ── cel-shade the causeway: ground, road, median + lit lamp poles/walls become MeshToon. The
  // sky/sun shaders, mountain + billboard basics, dashed neon and glow bars are left to bloom.
  // Instanced sources (dashes, walls, poles, bars) are toon-shaded but not per-instance outlined. ──
  const toonStats = toonifyWorld(group, { outlineWidth: 0.25, outlineMinSize: 3 });
  console.info(`[toon] oval: ${toonStats.toonMats} toon mats, ${toonStats.hulls} outline hulls, ${toonStats.instanced} instanced`);

  return {
    group,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) {
      if (states.length === 0 && remoteMap.size === 0) return; // hot path: the ghost seam idles every frame today
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.id);
        let m = remoteMap.get(s.id);
        if (!m) { m = new THREE.Mesh(remoteGeo, matIdle); remoteGroup.add(m); remoteMap.set(s.id, m); }
        m.material = s.dir === 1 ? matLong : s.dir === -1 ? matShort : matIdle;
        m.position.set(s.x, elevationAt(progress(s.x, s.z).s) + 0.9, s.z); m.rotation.y = -s.heading;
      }
      for (const [id, m] of remoteMap) if (!seen.has(id)) { remoteGroup.remove(m); remoteMap.delete(id); }
    },
    setBillboard(l1, l2) { drawBillboard(l1, l2); },
    update(_dt) {},
    dispose() {
      for (const d of disposables) d.dispose();
      remoteMap.clear();
    },
  };
}
