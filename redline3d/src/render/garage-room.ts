import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** the bits of a CarOption the showroom needs to place a car on the turntable */
export interface GarageCar {
  url: string;
  scale?: number;
  yaw?: number;
}

export interface GarageRoom {
  group: THREE.Group;
  /** load + place a car on the turntable (latest pick wins; big GLBs race) */
  setCar(opt: GarageCar): void;
  /** per-frame: spin the turntable, breathe the neon */
  update(dt: number): void;
  show(): void;
  hide(): void;
}

const MODEL_YAW = Math.PI;   // base facing, matches the in-game car
const CAR_LEN = 8.6;         // longest-axis footprint on the ~5.6-radius turntable
const PLATFORM_Y = 0.62;     // top of the spinning disc — the car sits here

/** "GARAGE" wordmark drawn to a canvas, used as a self-lit neon sign on the back wall. */
function signTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 220;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = "800 150px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#eafcff";
  g.shadowColor = "#27e7ff"; g.shadowBlur = 40;
  g.fillText("GARAGE", c.width / 2, c.height / 2 + 6);
  g.shadowBlur = 18;
  g.fillText("GARAGE", c.width / 2, c.height / 2 + 6); // double pass = fatter glow
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** soft radial light-pool sprite for the floor under the car. */
function poolTexture(): THREE.CanvasTexture {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(120,190,255,0.55)");
  grd.addColorStop(0.4, "rgba(80,120,230,0.22)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

/**
 * The drive-in garage showroom: a moody service bay you enter from the strip's GARAGE door.
 * Your equipped car sits hero-lit on a slowly rotating turntable, framed by a tool wall,
 * workbench, tire stacks and a neon GARAGE sign. Built in world space around the origin
 * (car at 0); the showroom camera in main.ts orbits it. Toggled via show()/hide() like the
 * race world / highway oval.
 */
export function createGarageRoom(renderer: THREE.WebGLRenderer): GarageRoom {
  const group = new THREE.Group();
  group.visible = false;
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // PMREM environment so the metallic car bodies catch reflections (like the card renderer)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // ---- shared materials ----
  const concrete = track(new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.82, metalness: 0.15, envMap: env, envMapIntensity: 0.18 }));
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0x0e1018, roughness: 0.92, metalness: 0.05 }));
  const pegMat = track(new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 0.8, metalness: 0.1 }));
  const metal = track(new THREE.MeshStandardMaterial({ color: 0x6b7484, roughness: 0.4, metalness: 0.85, envMap: env, envMapIntensity: 0.7 }));
  const darkMetal = track(new THREE.MeshStandardMaterial({ color: 0x20242e, roughness: 0.5, metalness: 0.7, envMap: env, envMapIntensity: 0.4 }));
  const redMat = track(new THREE.MeshStandardMaterial({ color: 0xcf3a2c, roughness: 0.5, metalness: 0.35 }));
  const tireMat = track(new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.95, metalness: 0 }));
  const cyan = track(new THREE.MeshStandardMaterial({ color: 0x27e7ff, emissive: 0x27e7ff, emissiveIntensity: 1.5 }));
  const magenta = track(new THREE.MeshStandardMaterial({ color: 0xff39c0, emissive: 0xff39c0, emissiveIntensity: 1.4 }));
  const amber = track(new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffb020, emissiveIntensity: 1.2 }));

  const HALF_X = 23, HALF_Z = 19, WALL_H = 15;

  // ================= FLOOR =================
  const floor = new THREE.Mesh(track(new THREE.BoxGeometry(HALF_X * 2, 0.3, HALF_Z * 2)), concrete);
  floor.position.set(0, -0.15, 0);
  group.add(floor);

  // painted service-bay rectangle around the turntable — 4 thin cyan edge strips
  const bayW = 30, bayD = 22;
  const stripLong = track(new THREE.BoxGeometry(bayW, 0.04, 0.34));
  const stripSide = track(new THREE.BoxGeometry(0.34, 0.04, bayD));
  for (const dz of [-bayD / 2, bayD / 2]) { const m = new THREE.Mesh(stripLong, cyan); m.position.set(0, 0.03, dz); group.add(m); }
  for (const dx of [-bayW / 2, bayW / 2]) { const m = new THREE.Mesh(stripSide, cyan); m.position.set(dx, 0.03, 0); group.add(m); }

  // hazard chevrons across the open front lip (amber / dark)
  const hazGeo = track(new THREE.BoxGeometry(2.1, 0.05, 1.0));
  for (let i = 0; i < 11; i++) {
    const m = new THREE.Mesh(hazGeo, i % 2 ? darkMetal : amber);
    m.rotation.y = Math.PI / 5;
    m.position.set(-11 + i * 2.2, 0.04, HALF_Z - 2.2);
    group.add(m);
  }

  // soft light pool under the car
  const pool = new THREE.Mesh(
    track(new THREE.PlaneGeometry(24, 24)),
    track(new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.05, 0);
  group.add(pool);

  // ================= WALLS (back + two sides; open front + top) =================
  const backWall = new THREE.Mesh(track(new THREE.BoxGeometry(HALF_X * 2, WALL_H, 0.6)), wallMat);
  backWall.position.set(0, WALL_H / 2, -HALF_Z);
  group.add(backWall);
  const sideGeo = track(new THREE.BoxGeometry(0.6, WALL_H, HALF_Z * 2));
  const wallL = new THREE.Mesh(sideGeo, wallMat); wallL.position.set(-HALF_X, WALL_H / 2, 0); group.add(wallL);
  const wallR = new THREE.Mesh(sideGeo, wallMat); wallR.position.set(HALF_X, WALL_H / 2, 0); group.add(wallR);

  // ceiling over the back half (front stays open for the key spot + the camera push-in) — fills the
  // top of the frame with a lit garage ceiling instead of black void, esp. on the portrait hero shot
  const ceiling = new THREE.Mesh(track(new THREE.BoxGeometry(HALF_X * 2, 0.4, HALF_Z)), wallMat);
  ceiling.position.set(0, WALL_H, -HALF_Z / 2);
  group.add(ceiling);
  const tubeGeo = track(new THREE.BoxGeometry(11, 0.18, 0.5));
  const tubeMat = track(new THREE.MeshStandardMaterial({ color: 0xeaf4ff, emissive: 0xdfeaff, emissiveIntensity: 1.5 }));
  for (const [tx, tz] of [[-8, -13], [8, -13], [-8, -5], [8, -5]] as const) {
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.set(tx, WALL_H - 0.32, tz);
    group.add(tube);
  }

  // neon floor-line trim along the wall bases (that neon-garage read)
  const trimBack = new THREE.Mesh(track(new THREE.BoxGeometry(HALF_X * 2, 0.14, 0.14)), magenta);
  trimBack.position.set(0, 0.2, -HALF_Z + 0.4); group.add(trimBack);
  const trimSideGeo = track(new THREE.BoxGeometry(0.14, 0.14, HALF_Z * 2));
  const trimL = new THREE.Mesh(trimSideGeo, cyan); trimL.position.set(-HALF_X + 0.4, 0.2, 0); group.add(trimL);
  const trimR = new THREE.Mesh(trimSideGeo, cyan); trimR.position.set(HALF_X - 0.4, 0.2, 0); group.add(trimR);

  // ================= NEON "GARAGE" SIGN (back wall) =================
  const sign = new THREE.Mesh(
    track(new THREE.PlaneGeometry(20, 4.3)),
    track(new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true, depthWrite: false })),
  );
  sign.position.set(0, 12, -HALF_Z + 0.35);
  group.add(sign);

  // ================= TOOL / PEGBOARD WALL (back wall, left of centre) =================
  const peg = new THREE.Mesh(track(new THREE.BoxGeometry(15, 8.5, 0.3)), pegMat);
  peg.position.set(-11, 6.4, -HALF_Z + 0.4);
  group.add(peg);
  // hung wrenches (thin bright bars) + a couple of sockets (small cylinders)
  const wrenchGeo = track(new THREE.BoxGeometry(0.45, 3.4, 0.2));
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(wrenchGeo, metal);
    w.position.set(-16 + i * 1.15, 7.6, -HALF_Z + 0.62);
    w.rotation.z = (i % 2 ? 1 : -1) * 0.12;
    group.add(w);
  }
  const sockGeo = track(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 12));
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(sockGeo, darkMetal);
    s.rotation.x = Math.PI / 2;
    s.position.set(-15.4 + i * 1.0, 4.5, -HALF_Z + 0.68);
    group.add(s);
  }
  // a hung tire on the pegboard
  const hungTire = new THREE.Mesh(track(new THREE.TorusGeometry(1.3, 0.5, 10, 22)), tireMat);
  hungTire.position.set(-6.5, 6.2, -HALF_Z + 0.85);
  group.add(hungTire);

  // ================= WORKBENCH + TOOLBOX (right wall) =================
  const benchTop = new THREE.Mesh(track(new THREE.BoxGeometry(13, 0.5, 3.2)), metal);
  benchTop.position.set(HALF_X - 2, 3.4, -4);
  group.add(benchTop);
  const legGeo = track(new THREE.BoxGeometry(0.35, 3.2, 0.35));
  for (const lz of [-5.3, -2.7]) for (const lx of [HALF_X - 7.6, HALF_X - 0.6]) {
    const leg = new THREE.Mesh(legGeo, darkMetal); leg.position.set(lx, 1.6, lz); group.add(leg);
  }
  // red toolbox chest (stacked drawers) on the bench
  const chest = new THREE.Mesh(track(new THREE.BoxGeometry(4.2, 2.6, 2.2)), redMat);
  chest.position.set(HALF_X - 3.2, 4.95, -4);
  group.add(chest);
  const drawerGeo = track(new THREE.BoxGeometry(4.24, 0.08, 0.12));
  for (let i = 0; i < 3; i++) { const d = new THREE.Mesh(drawerGeo, darkMetal); d.position.set(HALF_X - 3.2, 4.2 + i * 0.75, -2.86); group.add(d); }
  // a scatter of parts on the bench
  const partGeo = track(new THREE.BoxGeometry(0.8, 0.5, 1.2));
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(partGeo, i % 2 ? cyan : darkMetal); p.position.set(HALF_X - 8 + i * 1.0, 3.9, -5); p.rotation.y = i * 0.5; group.add(p); }

  // ================= TIRE STACKS (corners) =================
  const stackTireGeo = track(new THREE.TorusGeometry(1.15, 0.48, 10, 22));
  const placeStack = (x: number, z: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = new THREE.Mesh(stackTireGeo, tireMat);
      t.rotation.x = Math.PI / 2;
      t.position.set(x, 0.5 + i * 0.9, z);
      t.rotation.z = i * 0.4;
      group.add(t);
    }
  };
  placeStack(-HALF_X + 3, HALF_Z - 4, 4);
  placeStack(-HALF_X + 3.4, -HALF_Z + 4, 3);
  placeStack(HALF_X - 3, HALF_Z - 4, 3);

  // ================= TURNTABLE =================
  // static base ring + hoist columns
  const base = new THREE.Mesh(track(new THREE.CylinderGeometry(6.4, 6.9, 0.4, 48)), darkMetal);
  base.position.set(0, 0.2, 0);
  group.add(base);
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(6.4, 0.13, 10, 72)), cyan);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.44, 0);
  group.add(ring);
  // two hoist columns framing the car (back corners of the pad — clear of the spin)
  const colGeo = track(new THREE.CylinderGeometry(0.4, 0.45, 9, 14));
  for (const cx of [-6.7, 6.7]) {
    const col = new THREE.Mesh(colGeo, metal); col.position.set(cx, 4.5, -4.4); group.add(col);
    const cap = new THREE.Mesh(track(new THREE.BoxGeometry(1.3, 0.5, 1.3)), darkMetal); cap.position.set(cx, 9.2, -4.4); group.add(cap);
  }

  // spinning disc + car ride on this pivot
  const turntable = new THREE.Group();
  group.add(turntable);
  const disc = new THREE.Mesh(track(new THREE.CylinderGeometry(5.7, 5.7, 0.45, 48)), track(
    new THREE.MeshStandardMaterial({ color: 0x171b25, roughness: 0.35, metalness: 0.6, envMap: env, envMapIntensity: 0.5 }),
  ));
  disc.position.set(0, PLATFORM_Y - 0.22, 0);
  turntable.add(disc);
  const discRing = new THREE.Mesh(track(new THREE.TorusGeometry(4.7, 0.06, 8, 64)), magenta);
  discRing.rotation.x = Math.PI / 2; discRing.position.set(0, PLATFORM_Y + 0.02, 0);
  turntable.add(discRing);

  // ================= LIGHTS (ride inside the group → on/off with show/hide) =================
  group.add(track(new THREE.HemisphereLight(0x2a3550, 0x05060a, 0.55)));
  group.add(track(new THREE.AmbientLight(0x3a4358, 0.35)));
  const key = new THREE.SpotLight(0xfff2e0, 3.0, 60, 0.62, 0.55, 1.2);
  key.position.set(0, 17, 9);
  key.target.position.set(0, 1.6, 0);
  group.add(key); group.add(key.target);
  const rimC = new THREE.PointLight(0x27e7ff, 90, 46, 2); rimC.position.set(-11, 5, 7); group.add(rimC);
  const rimM = new THREE.PointLight(0xff39c0, 80, 46, 2); rimM.position.set(11, 5, -1); group.add(rimM);
  const backGlow = new THREE.PointLight(0x3355ff, 40, 40, 2); backGlow.position.set(0, 8, -14); group.add(backGlow);

  // ================= CAR (equipped car on the turntable) =================
  const loader = new GLTFLoader();
  let carObj: THREE.Object3D | null = null;
  let gen = 0;
  let lastReq = "";
  const disposeTree = (root: THREE.Object3D) => root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose());
  });

  const setCar = (opt: GarageCar): void => {
    const req = `${opt.url}|${opt.scale ?? 1}|${opt.yaw ?? 0}`;
    if (req === lastReq) return; // re-selecting the shown car → no refetch
    lastReq = req;
    const my = ++gen;
    loader.load(
      opt.url,
      (gltf) => {
        if (my !== gen) { disposeTree(gltf.scene); return; } // a newer pick won
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.scale.setScalar((CAR_LEN / (Math.max(size.x, size.z) || 1)) * (opt.scale ?? 1));
        model.rotation.y = MODEL_YAW + (opt.yaw ?? 0);
        const box2 = new THREE.Box3().setFromObject(model);
        const c = box2.getCenter(new THREE.Vector3());
        model.position.set(-c.x, PLATFORM_Y - box2.min.y, -c.z);
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const mm of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
            const sm = mm as THREE.MeshStandardMaterial;
            if (sm.isMeshStandardMaterial) { sm.envMap = env; sm.envMapIntensity = 0.9; }
          }
        });
        if (carObj) { turntable.remove(carObj); disposeTree(carObj); }
        carObj = model;
        turntable.add(model);
      },
      undefined,
      (err) => { if (my === gen) { lastReq = ""; } console.warn("[garage] GLB failed:", opt.url, err); },
    );
  };

  // ================= UPDATE =================
  let t = 0;
  const update = (dt: number): void => {
    t += dt;
    turntable.rotation.y += dt * 0.28;                          // slow auto-turn
    cyan.emissiveIntensity = 1.35 + 0.3 * Math.sin(t * 1.6);    // turntable ring breathes
    magenta.emissiveIntensity = 1.25 + 0.25 * Math.sin(t * 1.6 + 1.5);
  };

  return {
    group,
    setCar,
    update,
    show() { group.visible = true; },
    hide() { group.visible = false; },
  };
}
