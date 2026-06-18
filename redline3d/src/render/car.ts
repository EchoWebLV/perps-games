import * as THREE from "three";

export interface Car {
  group: THREE.Group;
  /** color by equity state: idle blue, winning green, losing red */
  setEquity(phase: "idle" | "live", equity: number): void;
  update(dt: number): void;
}

export function createCar(): Car {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#11131f", emissive: "#4da6ff", emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.4 });
  const glowMat = new THREE.MeshStandardMaterial({ color: "#ff2d55", emissive: "#ff2d55", emissiveIntensity: 1.2 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.0, 7.2), bodyMat);
  body.position.y = 0.9;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.0, 3.0), bodyMat);
  cabin.position.set(0, 1.7, 0.3);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.4, 0.5), glowMat); // rear light bar
  tail.position.set(0, 1.0, 3.7);
  group.add(body, cabin, tail);

  // underglow
  const glow = new THREE.PointLight("#4da6ff", 8, 18, 2);
  glow.position.set(0, 0.4, 0);
  group.add(glow);

  let t = 0;
  return {
    group,
    setEquity(phase, equity) {
      const col = phase === "idle" ? "#4da6ff" : equity >= 1 ? "#2ee6a6" : "#ff5067";
      bodyMat.emissive.set(col);
      glow.color.set(col);
    },
    update(dt) {
      t += dt;
      group.position.y = Math.sin(t * 2.2) * 0.05; // idle hover wobble
    },
  };
}
