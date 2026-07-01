import * as THREE from "three";
import { BUILDINGS, LOT_BOUNDS } from "../core/lobby-layout";
import { buildBuilding } from "./buildings";

export interface RemoteCarState { id: string; x: number; z: number; heading: number }

export interface Lobby {
  group: THREE.Group;
  show(): void;
  hide(): void;
  /** multiplayer seam — called with [] today; later a presence feed drives ghost cars */
  setRemoteCars(states: RemoteCarState[]): void;
  update(dt: number): void;
  dispose(): void;
}

function signTexture(name: string, css: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = "700 84px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = css; g.shadowBlur = 28;
  g.fillStyle = css;
  g.fillText(name, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export function createLobby(): Lobby {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // floor
  const floorGeo = track(new THREE.PlaneGeometry(LOT_BOUNDS.x * 2, LOT_BOUNDS.z * 2));
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.55, roughness: 0.45 }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  // neon grid over the floor
  const grid = new THREE.GridHelper(Math.max(LOT_BOUNDS.x, LOT_BOUNDS.z) * 2, 60, 0xff4dd2, 0x6a2bd9);
  const gm = grid.material as THREE.Material & { opacity: number };
  gm.transparent = true; gm.opacity = 0.32;
  grid.position.y = 0.02;
  group.add(grid);

  // glowing perimeter walls
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x180a30, emissive: 0xff4dd2, emissiveIntensity: 0.55 }));
  const wallGeoLR = track(new THREE.BoxGeometry(1, 2.4, LOT_BOUNDS.z * 2));
  const wallGeoFB = track(new THREE.BoxGeometry(LOT_BOUNDS.x * 2, 2.4, 1));
  const addWall = (geo: THREE.BoxGeometry, x: number, z: number) => {
    const m = new THREE.Mesh(geo, wallMat); m.position.set(x, 1.2, z); group.add(m);
  };
  addWall(wallGeoLR, -LOT_BOUNDS.x, 0); addWall(wallGeoLR, LOT_BOUNDS.x, 0);
  addWall(wallGeoFB, 0, -LOT_BOUNDS.z); addWall(wallGeoFB, 0, LOT_BOUNDS.z);

  // buildings — each corner gets a themed structure (garage bay / start gate / upgrade tower /
  // container yard). The builder makes it in local space with the entrance on +Z; we position it
  // in its corner and rotate `b.rot` so that +Z faces the plaza, then float the neon sign + a lamp
  // out in front. Any animated greebles register an `animate(t)` we drive from update().
  const animators: Array<(t: number) => void> = [];
  for (const b of BUILDINGS) {
    const bg = new THREE.Group(); bg.position.set(b.x, 0, b.z); bg.rotation.y = b.rot;
    const hex = "#" + b.color.toString(16).padStart(6, "0");

    const built = buildBuilding(b.kind, b.color, track);
    bg.add(built.group);
    if (built.animate) animators.push(built.animate);

    const signGeo = track(new THREE.PlaneGeometry(b.w * 0.92, b.w * 0.92 / 4));
    const signMat = track(new THREE.MeshBasicMaterial({ map: track(signTexture(b.name, hex)), transparent: true, depthWrite: false }));
    const sign = new THREE.Mesh(signGeo, signMat); sign.position.set(0, built.signY, built.frontZ + 0.1); bg.add(sign);

    const lamp = new THREE.PointLight(b.color, 7, 34, 2); lamp.position.set(0, 5, built.frontZ + 3); bg.add(lamp);
    group.add(bg);
  }

  // ambient fill so the lot isn't pitch black
  const amb = new THREE.AmbientLight(0x6a4cff, 0.5); group.add(amb);

  // remote cars — multiplayer seam (empty today)
  const remoteGroup = new THREE.Group(); group.add(remoteGroup);
  const remoteMap = new Map<string, THREE.Mesh>();
  const remoteGeo = track(new THREE.BoxGeometry(3.6, 1.6, 7));
  const remoteMat = track(new THREE.MeshStandardMaterial({ color: 0x222233, emissive: 0x4da6ff, emissiveIntensity: 0.4 }));

  let t = 0;
  return {
    group,
    show() { group.visible = true; },
    hide() { group.visible = false; },
    setRemoteCars(states) {
      const seen = new Set<string>();
      for (const s of states) {
        seen.add(s.id);
        let m = remoteMap.get(s.id);
        if (!m) { m = new THREE.Mesh(remoteGeo, remoteMat); remoteGroup.add(m); remoteMap.set(s.id, m); }
        m.position.set(s.x, 0.9, s.z); m.rotation.y = s.heading;
      }
      for (const [id, m] of remoteMap) if (!seen.has(id)) { remoteGroup.remove(m); remoteMap.delete(id); }
    },
    update(dt) { t += dt; for (const a of animators) a(t); },
    dispose() {
      for (const d of disposables) d.dispose();
      remoteMap.clear();
    },
  };
}
