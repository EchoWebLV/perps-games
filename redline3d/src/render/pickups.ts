import * as THREE from "three";

export interface Pickups {
  group: THREE.Group;
  /** advance pickups; returns how many were collected by the car at carX this frame */
  update(dt: number, speed: number, carX: number): number;
}

const LANES = [-8, -4, 0, 4, 8];
const N = 9;
const SP = 110;          // spacing along z
const TOTAL = N * SP;
const RECYCLE = 22;      // z past the camera → wrap to the far end
const CATCH_Z0 = -14, CATCH_Z1 = -9;  // z window around the car where a coin can be caught
const CATCH_X = 3.2;     // lateral catch radius

export function createPickups(): Pickups {
  const group = new THREE.Group();
  const geo = new THREE.OctahedronGeometry(0.95);
  const mat = new THREE.MeshStandardMaterial({ color: "#3a2a00", emissive: "#ffd166", emissiveIntensity: 1.5, metalness: 0.6, roughness: 0.3 });
  const coins: THREE.Mesh[] = [];

  const place = (m: THREE.Mesh, z: number) => {
    m.position.set(LANES[(Math.random() * LANES.length) | 0], 1.7, z);
    m.visible = true;
  };
  for (let i = 0; i < N; i++) {
    const m = new THREE.Mesh(geo, mat);
    place(m, RECYCLE - 240 - i * SP);
    group.add(m);
    coins.push(m);
  }

  return {
    group,
    update(dt, speed, carX) {
      let got = 0;
      for (const m of coins) {
        m.position.z += speed * dt;
        m.rotation.y += dt * 3.2;
        if (m.visible && m.position.z > CATCH_Z0 && m.position.z < CATCH_Z1 && Math.abs(m.position.x - carX) < CATCH_X) {
          m.visible = false;
          got++;
        }
        if (m.position.z > RECYCLE) place(m, m.position.z - TOTAL);
      }
      return got;
    },
  };
}
