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

/**
 * A DeLorean-STYLE wedge — brushed stainless body, flat doorstop profile, rear
 * louvers, gullwing roof seams, pop-up headlights. Our own geometry (no licensed
 * mesh), so it evokes the synthwave time-machine vibe with no trademark risk.
 */
export function createCar(): Car {
  const group = new THREE.Group();

  // brushed stainless steel — the signature look; tints subtly with the equity accent
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#aab2bd", metalness: 0.95, roughness: 0.42, emissive: IDLE, emissiveIntensity: 0.22 });
  const accentMat = new THREE.MeshStandardMaterial({ color: "#0b0e18", emissive: IDLE, emissiveIntensity: 1.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: "#0a0f1f", metalness: 0.9, roughness: 0.12, emissive: "#10203a", emissiveIntensity: 0.45 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#0c0d11", metalness: 0.5, roughness: 0.7 }); // black bumpers, cladding, louvers
  const tireMat = new THREE.MeshStandardMaterial({ color: "#070709", roughness: 0.9 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: "#180408", emissive: "#ff2d55", emissiveIntensity: 1.7 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    group.add(m);
    return m;
  };

  // car faces -Z: nose at -Z, tail at +Z
  // --- main tub + flat doorstop profile ---
  add(new THREE.BoxGeometry(4.0, 0.45, 6.8), bodyMat, 0, 0.64, 0.1);          // floor / sills
  add(new THREE.BoxGeometry(3.5, 0.34, 2.9), bodyMat, 0, 0.92, -2.0, 0.05);    // low flat hood (slight nose-down)
  add(new THREE.BoxGeometry(3.0, 0.26, 1.1), bodyMat, 0, 0.74, -3.5);          // pointed nose wedge
  add(new THREE.BoxGeometry(3.7, 0.3, 0.45), trimMat, 0, 0.58, -3.55);         // front bumper band
  add(new THREE.BoxGeometry(0.6, 0.18, 0.3), accentMat, 1.0, 0.98, -3.0);      // pop-up headlight L
  add(new THREE.BoxGeometry(0.6, 0.18, 0.3), accentMat, -1.0, 0.98, -3.0);     // pop-up headlight R

  // --- low wraparound greenhouse + roof, with gullwing seams ---
  add(new THREE.BoxGeometry(3.0, 0.6, 2.8), glassMat, 0, 1.28, -0.2);          // glasshouse
  add(new THREE.BoxGeometry(2.7, 0.16, 2.2), bodyMat, 0, 1.64, -0.2);          // roof
  add(new THREE.BoxGeometry(0.06, 0.07, 2.1), accentMat, 1.27, 1.6, -0.2);     // gullwing seam L
  add(new THREE.BoxGeometry(0.06, 0.07, 2.1), accentMat, -1.27, 1.6, -0.2);    // gullwing seam R

  // --- rear deck + the iconic louvered rear window ---
  add(new THREE.BoxGeometry(3.6, 0.5, 2.4), bodyMat, 0, 1.0, 2.4);             // rear deck
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    add(new THREE.BoxGeometry(2.6, 0.05, 0.46), trimMat, 0, 1.5 - t * 0.42, 0.95 + t * 1.35, -0.32); // louver slats
  }
  add(new THREE.BoxGeometry(3.7, 0.34, 0.3), brakeMat, 0, 1.0, 3.55);          // taillight bar (always red)
  add(new THREE.BoxGeometry(3.7, 0.3, 0.45), trimMat, 0, 0.62, 3.6);           // rear bumper band

  // --- side neon sill strips (the synthwave glow line) + black belt cladding ---
  add(new THREE.BoxGeometry(0.12, 0.18, 6.4), accentMat, 2.02, 0.72, 0.1);
  add(new THREE.BoxGeometry(0.12, 0.18, 6.4), accentMat, -2.02, 0.72, 0.1);
  add(new THREE.BoxGeometry(0.08, 0.16, 5.4), trimMat, 2.02, 1.04, 0.1);
  add(new THREE.BoxGeometry(0.08, 0.16, 5.4), trimMat, -2.02, 1.04, 0.1);

  // --- wheels: dark tire + glowing rim, axle along X ---
  const tireGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.7, 16);
  const rimGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.74, 8);
  for (const wx of [-2.05, 2.05]) {
    for (const wz of [-2.4, 2.6]) {
      add(tireGeo, tireMat, wx, 0.78, wz, 0, 0, Math.PI / 2);
      add(rimGeo, accentMat, wx, 0.78, wz, 0, 0, Math.PI / 2);
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
      accentMat.emissiveIntensity = 1.4 + Math.sin(t * 3) * 0.25; // subtle neon breathing
    },
  };
}
