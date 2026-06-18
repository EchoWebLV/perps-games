import * as THREE from "three";

export interface Car {
  group: THREE.Group;
  /** color by equity state: idle blue, winning green, losing red */
  setEquity(phase: "idle" | "live", equity: number): void;
  update(dt: number): void;
}

const IDLE = "#4da6ff";
const WIN = "#2ee6a6";
const LOSE = "#ff5067";

export function createCar(): Car {
  const group = new THREE.Group();

  // dark body that subtly tints with the equity accent; sharp low-poly wedge
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#0b0e18", metalness: 0.55, roughness: 0.35, emissive: IDLE, emissiveIntensity: 0.28 });
  const accentMat = new THREE.MeshStandardMaterial({ color: "#0b0e18", emissive: IDLE, emissiveIntensity: 1.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: "#0a0f1f", metalness: 0.9, roughness: 0.1, emissive: "#10203a", emissiveIntensity: 0.4 });
  const tireMat = new THREE.MeshStandardMaterial({ color: "#070709", roughness: 0.9 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: "#180408", emissive: "#ff2d55", emissiveIntensity: 1.7 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };

  // body
  add(new THREE.BoxGeometry(4.2, 0.7, 6.8), bodyMat, 0, 0.75, 0);
  add(new THREE.BoxGeometry(3.0, 0.5, 2.2), bodyMat, 0, 0.6, -3.0);          // tapered nose
  add(new THREE.BoxGeometry(2.2, 0.85, 2.4), glassMat, 0, 1.45, -0.1);       // canopy
  add(new THREE.BoxGeometry(3.8, 0.55, 2.2), bodyMat, 0, 0.9, 2.4);          // rear deck

  // side neon strips (the synthwave glow line)
  add(new THREE.BoxGeometry(0.14, 0.2, 6.6), accentMat, 2.05, 1.02, 0);
  add(new THREE.BoxGeometry(0.14, 0.2, 6.6), accentMat, -2.05, 1.02, 0);

  // rear wing
  add(new THREE.BoxGeometry(4.8, 0.22, 1.1), accentMat, 0, 2.05, 3.5);
  add(new THREE.BoxGeometry(0.32, 0.95, 0.34), bodyMat, 1.7, 1.55, 3.5);
  add(new THREE.BoxGeometry(0.32, 0.95, 0.34), bodyMat, -1.7, 1.55, 3.5);

  // brake light bar (always red)
  add(new THREE.BoxGeometry(3.9, 0.34, 0.34), brakeMat, 0, 1.05, 3.62);

  // wheels (dark tire + glowing rim), axle along X
  const tireGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.7, 16);
  const rimGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.74, 16);
  const wheelRims: THREE.Mesh[] = [];
  for (const wx of [-2.25, 2.25]) {
    for (const wz of [-2.2, 2.4]) {
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.position.set(wx, 0.75, wz);
      const rim = new THREE.Mesh(rimGeo, accentMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(wx, 0.75, wz);
      group.add(tire, rim);
      wheelRims.push(rim);
    }
  }

  const glow = new THREE.PointLight(IDLE, 9, 22, 2);
  glow.position.set(0, 0.4, 0);
  group.add(glow);

  let t = 0;
  return {
    group,
    setEquity(phase, equity) {
      const col = phase === "idle" ? IDLE : equity >= 1 ? WIN : LOSE;
      bodyMat.emissive.set(col);
      accentMat.emissive.set(col);
      glow.color.set(col);
    },
    update(dt) {
      t += dt;
      group.position.y = Math.sin(t * 2.2) * 0.05; // idle hover wobble
    },
  };
}
