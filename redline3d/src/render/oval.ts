import * as THREE from "three";
import { TRACK, LEN, sample } from "../core/track";

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

/** a flat ribbon between two lateral offsets, sampled along the whole loop */
function ribbonGeometry(latA: number, latB: number, y: number, step = 4): THREE.BufferGeometry {
  const n = Math.ceil(LEN / step);
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const c = sample((i / n) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    pos.push(c.x + rx * latA, y, c.z + rz * latA, c.x + rx * latB, y, c.z + rz * latB);
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

  // ground + neon grid (same palette as the lobby lot)
  const groundGeo = track(new THREE.PlaneGeometry(900, 700));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
  group.add(ground);
  const grid = new THREE.GridHelper(760, 76, 0xff4dd2, 0x6a2bd9);
  const gm = grid.material as THREE.Material & { opacity: number };
  gm.transparent = true; gm.opacity = 0.28;
  grid.position.y = -0.02;
  group.add(grid);

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

  // dashed lane dividers: one per carriageway at lat ±(MEDIAN_HALF + LANE_W)
  const dashMat = track(new THREE.MeshBasicMaterial({ color: 0x9ad7ff }));
  const dashGeo = track(new THREE.PlaneGeometry(0.35, 3));
  const laneLat = MEDIAN_HALF + TRACK.LANE_W;
  const dashCount = Math.floor(LEN / 9);
  const dashes = new THREE.InstancedMesh(dashGeo, dashMat, dashCount * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let di = 0;
  for (let i = 0; i < dashCount; i++) {
    const c = sample((i / dashCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      // plane lies flat (rotated −90° around X), long axis along the travel direction
      q.setFromAxisAngle(up, -c.heading).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      m4.compose(new THREE.Vector3(c.x + rx * laneLat * side, 0.03, c.z + rz * laneLat * side), q, new THREE.Vector3(1, 1, 1));
      dashes.setMatrixAt(di++, m4);
    }
  }
  group.add(dashes);

  // outer barrier: low glowing wall segments (instanced), like the lobby's perimeter
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeo = track(new THREE.BoxGeometry(0.6, 1.6, 6.4));
  const wallCount = Math.floor(LEN / 6);
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallCount * 2);
  let wi = 0;
  for (let i = 0; i < wallCount; i++) {
    const c = sample((i / wallCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      q.setFromAxisAngle(up, -c.heading);
      m4.compose(new THREE.Vector3(c.x + rx * (EDGE + 0.6) * side, 0.8, c.z + rz * (EDGE + 0.6) * side), q, new THREE.Vector3(1, 1, 1));
      walls.setMatrixAt(wi++, m4);
    }
  }
  group.add(walls);

  // lamp posts every ~48m outside the barrier: violet pole + magenta bar (emissive only)
  const poleMat = track(new THREE.MeshStandardMaterial({ color: 0x160f2e, emissive: 0x5a3fd6, emissiveIntensity: 0.8 }));
  const barMat = track(new THREE.MeshStandardMaterial({ color: 0x2a0f24, emissive: 0xff2d95, emissiveIntensity: 1.6 }));
  const poleGeo = track(new THREE.CylinderGeometry(0.18, 0.18, 7, 6));
  const barGeo = track(new THREE.BoxGeometry(2.6, 0.28, 0.28));
  const lampCount = Math.floor(LEN / 48);
  for (let i = 0; i < lampCount; i++) {
    const c = sample((i / lampCount) * LEN);
    const rx = Math.cos(c.heading), rz = Math.sin(c.heading);
    for (const side of [1, -1]) {
      const px = c.x + rx * (EDGE + 3.4) * side, pz = c.z + rz * (EDGE + 3.4) * side;
      const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(px, 3.5, pz); group.add(pole);
      const bar = new THREE.Mesh(barGeo, barMat); bar.position.set(px, 7.1, pz); bar.rotation.y = -c.heading; group.add(bar);
    }
  }

  // trackside price billboard (east straight, outside the barrier)
  const bbCanvas = document.createElement("canvas");
  bbCanvas.width = 512; bbCanvas.height = 256;
  const bbTex = track(new THREE.CanvasTexture(bbCanvas));
  const drawBillboard = (l1: string, l2: string) => {
    const g = bbCanvas.getContext("2d")!;
    g.fillStyle = "#0c0a18"; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = "#2de2e6"; g.lineWidth = 8; g.strokeRect(6, 6, 500, 244);
    g.textAlign = "center"; g.font = "700 72px 'Chakra Petch', ui-monospace, monospace";
    g.fillStyle = "#2de2e6"; g.fillText(l1, 256, 104);
    g.fillStyle = "#35ff9d"; g.fillText(l2, 256, 200);
    bbTex.needsUpdate = true;
  };
  drawBillboard("PERPS", "RAIDER");
  const bbMat = track(new THREE.MeshBasicMaterial({ map: bbTex }));
  const bbGeo = track(new THREE.PlaneGeometry(22, 11));
  const bb = new THREE.Mesh(bbGeo, bbMat);
  bb.position.set(R + EDGE + 12, 9, 20);
  bb.rotation.y = -Math.PI / 2; // face the east straight (toward −x)
  group.add(bb);
  const bbPoleGeo = track(new THREE.CylinderGeometry(0.35, 0.35, 7, 6));
  for (const dz of [-8, 8]) {
    const p = new THREE.Mesh(bbPoleGeo, poleMat); p.position.set(R + EDGE + 12, 3.5, 20 + dz); group.add(p);
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

  return {
    group,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) {
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.id);
        let m = remoteMap.get(s.id);
        if (!m) { m = new THREE.Mesh(remoteGeo, matIdle); remoteGroup.add(m); remoteMap.set(s.id, m); }
        m.material = s.dir === 1 ? matLong : s.dir === -1 ? matShort : matIdle;
        m.position.set(s.x, 0.9, s.z); m.rotation.y = -s.heading;
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
