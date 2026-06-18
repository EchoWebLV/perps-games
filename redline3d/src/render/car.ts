import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface Car {
  group: THREE.Group;
  /** color by equity state: idle blue, winning green, losing red */
  setEquity(phase: "idle" | "live", equity: number): void;
  update(dt: number): void;
  /** swap the GLB model (car picker) */
  setModel(url: string): void;
  /** turn the front wheels for steering (−1 full left … 0 straight … +1 full right) */
  setSteer(angle: number): void;
}

const IDLE = "#4da6ff";
const WIN = "#2ee6a6";
const LOSE = "#ff5067";

const MODEL_URL = "/models/car.glb?v=2"; // bump to bust the browser cache when the model changes
const TARGET_LEN = 11.23;     // scale the model so its longest horizontal axis ≈ our footprint (+30% then +20%)
const MODEL_YAW = Math.PI;    // spin so the car faces down the road (-Z); tune in π/2 steps if needed
const MAX_STEER = 0.5;        // radians the front wheels swing at full lock (~28°)

/**
 * The player car. Loads the real GLB model and normalizes it (scale → our
 * footprint, center, sit on the road). A procedural stainless wedge shows
 * instantly and stays as a fallback if the model is slow or fails to load.
 * Either way the body tints blue→green→red with equity, and an underglow
 * PointLight carries the color cue onto the road.
 */
export function createCar(onReady?: () => void): Car {
  const group = new THREE.Group();
  let readyFired = false; // fire onReady once, when the first GLB finishes loading

  // ---- instant procedural fallback (a DeLorean-style stainless wedge) ----
  const placeholder = new THREE.Group();
  group.add(placeholder);
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#aab2bd", metalness: 0.95, roughness: 0.42, emissive: IDLE, emissiveIntensity: 0.22 });
  const accentMat = new THREE.MeshStandardMaterial({ color: "#0b0e18", emissive: IDLE, emissiveIntensity: 1.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: "#0a0f1f", metalness: 0.9, roughness: 0.12, emissive: "#10203a", emissiveIntensity: 0.45 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#0c0d11", metalness: 0.5, roughness: 0.7 });
  const tireMat = new THREE.MeshStandardMaterial({ color: "#070709", roughness: 0.9 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: "#180408", emissive: "#ff2d55", emissiveIntensity: 1.7 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    placeholder.add(m);
  };
  add(new THREE.BoxGeometry(4.0, 0.45, 6.8), bodyMat, 0, 0.64, 0.1);
  add(new THREE.BoxGeometry(3.5, 0.34, 2.9), bodyMat, 0, 0.92, -2.0, 0.05);
  add(new THREE.BoxGeometry(3.0, 0.26, 1.1), bodyMat, 0, 0.74, -3.5);
  add(new THREE.BoxGeometry(3.7, 0.3, 0.45), trimMat, 0, 0.58, -3.55);
  add(new THREE.BoxGeometry(0.6, 0.18, 0.3), accentMat, 1.0, 0.98, -3.0);
  add(new THREE.BoxGeometry(0.6, 0.18, 0.3), accentMat, -1.0, 0.98, -3.0);
  add(new THREE.BoxGeometry(3.0, 0.6, 2.8), glassMat, 0, 1.28, -0.2);
  add(new THREE.BoxGeometry(2.7, 0.16, 2.2), bodyMat, 0, 1.64, -0.2);
  add(new THREE.BoxGeometry(0.06, 0.07, 2.1), accentMat, 1.27, 1.6, -0.2);
  add(new THREE.BoxGeometry(0.06, 0.07, 2.1), accentMat, -1.27, 1.6, -0.2);
  add(new THREE.BoxGeometry(3.6, 0.5, 2.4), bodyMat, 0, 1.0, 2.4);
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    add(new THREE.BoxGeometry(2.6, 0.05, 0.46), trimMat, 0, 1.5 - t * 0.42, 0.95 + t * 1.35, -0.32);
  }
  add(new THREE.BoxGeometry(3.7, 0.34, 0.3), brakeMat, 0, 1.0, 3.55);
  add(new THREE.BoxGeometry(3.7, 0.3, 0.45), trimMat, 0, 0.62, 3.6);
  add(new THREE.BoxGeometry(0.12, 0.18, 6.4), accentMat, 2.02, 0.72, 0.1);
  add(new THREE.BoxGeometry(0.12, 0.18, 6.4), accentMat, -2.02, 0.72, 0.1);
  const tireGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.7, 16);
  const rimGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.74, 8);
  for (const wx of [-2.05, 2.05]) {
    for (const wz of [-2.4, 2.6]) {
      add(tireGeo, tireMat, wx, 0.78, wz, 0, 0, Math.PI / 2);
      add(rimGeo, accentMat, wx, 0.78, wz, 0, 0, Math.PI / 2);
    }
  }

  // underglow — colored by equity, casts the win/lose cue onto the road (stays for both fallback + model)
  const glow = new THREE.PointLight(IDLE, 9, 22, 2);
  glow.position.set(0, 0.4, 0);
  group.add(glow);

  // tint state, applied to whichever materials are currently active
  let phaseS: "idle" | "live" = "idle";
  let eqS = 1;
  let modelMats: THREE.MeshStandardMaterial[] | null = null;
  const applyTint = () => {
    const col = phaseS === "idle" ? IDLE : eqS >= 1 ? WIN : LOSE;
    glow.color.set(col);
    if (modelMats) {
      // keep the tint a faint hint so the stainless steel stays visible, not painted
      const inten = phaseS === "idle" ? 0.03 : 0.06;
      for (const m of modelMats) { m.emissive.set(col); m.emissiveIntensity = inten; }
    } else {
      bodyMat.emissive.set(col);
      accentMat.emissive.set(col);
    }
  };

  // ---- model loading / swapping (car picker) ----
  const loader = new GLTFLoader();
  let current: THREE.Object3D | null = null;
  // front-wheel nodes (+ their rest rotation) so steering is an offset, not absolute
  let frontWheels: { o: THREE.Object3D; baseY: number }[] = [];
  const loadModel = (url: string) => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        // scale to our footprint, center horizontally, sit wheels on the ground
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.scale.setScalar(TARGET_LEN / (Math.max(size.x, size.z) || 1));
        model.rotation.y = MODEL_YAW;
        const box2 = new THREE.Box3().setFromObject(model);
        const c = box2.getCenter(new THREE.Vector3());
        model.position.set(-c.x, -box2.min.y, -c.z);

        // collect tintable materials + the steerable front-wheel nodes
        const mats: THREE.MeshStandardMaterial[] = [];
        const wheels: { o: THREE.Object3D; baseY: number }[] = [];
        model.traverse((o) => {
          if (/wheel.*front/i.test(o.name)) wheels.push({ o, baseY: o.rotation.y });
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mm of list) {
            if ((mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) mats.push(mm as THREE.MeshStandardMaterial);
          }
        });
        if (current) group.remove(current);
        current = model;
        frontWheels = wheels;
        modelMats = mats.length ? mats : null;
        placeholder.visible = false;
        group.add(model);
        applyTint();
        if (!readyFired) { readyFired = true; onReady?.(); }
      },
      undefined,
      (err) => console.warn("[car] GLB failed to load:", url, err)
    );
  };
  loadModel(MODEL_URL);

  let t = 0;
  return {
    group,
    setEquity(phase, equity) {
      phaseS = phase;
      eqS = equity;
      applyTint();
    },
    update(dt) {
      t += dt;
      glow.intensity = 2 + Math.sin(t * 3) * 0.5; // faint underglow breathing
    },
    setSteer(angle) {
      const a = Math.max(-1, Math.min(1, angle)) * MAX_STEER;
      for (const w of frontWheels) w.o.rotation.y = w.baseY + a;
    },
    setModel: loadModel,
  };
}
