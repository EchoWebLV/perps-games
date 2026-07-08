import * as THREE from "three";
import type { BuiltBuilding, Track } from "./types";

/** Junkyard: stacked crushed cars, a loose scrap heap, and a swaying magnet crane over the pile.
 *  Front (+Z) is the open yard gate. Coming soon — no interaction, just the look + a hazard beacon. */
export function buildScrapyard(color: number, track: Track): BuiltBuilding {
  // ---- shared materials (create once, reuse across meshes) ----
  const body: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({
      color: 0x1a0f0a,
      emissive: color,
      emissiveIntensity: 0.16,
      metalness: 0.4,
      roughness: 0.6,
    }),
  );
  const darkTrim: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x0f0a08, metalness: 0.5, roughness: 0.55 }),
  );
  const neon: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );
  const metal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.45 }),
  );
  const darkMetal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x2a2622, metalness: 0.75, roughness: 0.5 }),
  );
  // Crushed-car hulks: dull faded automotive paints with a faint rust self-glow so the wrecks read
  // against the near-black lot instead of collapsing into dark voids.
  const carMats: THREE.MeshStandardMaterial[] = [
    track(new THREE.MeshStandardMaterial({ color: 0x6b2f2a, emissive: color, emissiveIntensity: 0.12, metalness: 0.5, roughness: 0.6 })),
    track(new THREE.MeshStandardMaterial({ color: 0x2f4a5c, emissive: color, emissiveIntensity: 0.1, metalness: 0.5, roughness: 0.6 })),
    track(new THREE.MeshStandardMaterial({ color: 0x5c4a2a, emissive: color, emissiveIntensity: 0.1, metalness: 0.5, roughness: 0.6 })),
    track(new THREE.MeshStandardMaterial({ color: 0x3d4038, emissive: color, emissiveIntensity: 0.12, metalness: 0.5, roughness: 0.6 })),
  ];

  const group = new THREE.Group();

  const HALF_X = 14;
  const HALF_Z = 8;
  const WALL_H = 10;
  const WALL_T = 0.6;

  // ---- floor slab ----
  const floorGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(28, 0.1, 16));
  const floor = new THREE.Mesh(floorGeo, darkTrim);
  floor.position.set(0, 0.05, 0);
  group.add(floor);

  // ---- back corrugated shed wall (−Z) ----
  const backWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(28, WALL_H, WALL_T));
  const backWall = new THREE.Mesh(backWallGeo, body);
  backWall.position.set(0, WALL_H / 2, -HALF_Z + WALL_T / 2);
  group.add(backWall);

  // corrugation ribs down the back wall (dark grooves on the faintly-lit shed)
  const wallRibGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.25, WALL_H - 1, 0.12));
  for (let rx = -12; rx <= 12; rx += 2.4) {
    const rib = new THREE.Mesh(wallRibGeo, darkTrim);
    rib.position.set(rx, WALL_H / 2, -HALF_Z + WALL_T + 0.08);
    group.add(rib);
  }

  // ---- partial side wall (+X only — the −X side stays open to the yard) ----
  const sideWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(WALL_T, WALL_H, 16));
  const sideWallPX = new THREE.Mesh(sideWallGeo, body);
  sideWallPX.position.set(HALF_X - WALL_T / 2, WALL_H / 2, 0);
  group.add(sideWallPX);

  // roofline neon strip along the back wall top edge — reads as a shed silhouette at night
  const backStripGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(27.6, 0.15, 0.2));
  const backStrip = new THREE.Mesh(backStripGeo, neon);
  backStrip.position.set(0, WALL_H, -HALF_Z + WALL_T);
  group.add(backStrip);

  // ---- crushed-car hulks: flattened boxes with a neon trim edge, stacked into two haphazard piles ----
  const carGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(5, 1.7, 3));
  const carTrimGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(5.05, 0.1, 0.1));
  let carN = 0;
  function placeCar(cx: number, cy: number, cz: number, yaw: number): void {
    const car = new THREE.Mesh(carGeo, carMats[carN % carMats.length]);
    carN++;
    car.position.set(cx, cy, cz);
    car.rotation.y = yaw;
    group.add(car);
    // faint neon rim along the +Z bottom edge so the wreck's silhouette catches the eye
    const trim = new THREE.Mesh(carTrimGeo, neon);
    trim.position.set(cx, cy - 0.82, cz + 1.55);
    trim.rotation.y = yaw;
    group.add(trim);
  }
  // stack toward −X (deep in the yard)
  placeCar(-8, 0.95, -3, 0.16);
  placeCar(-8.4, 2.7, -3.3, -0.22);
  placeCar(-7.7, 4.45, -3, 0.1);
  // stack under the crane (toward +X, front-of-centre — looks freshly dropped)
  placeCar(3, 0.95, -3.5, -0.12);
  placeCar(3.4, 2.7, -3, 0.28);

  // ---- loose scrap heap near front-centre: a cluster of small tilted chunks + a couple of cones ----
  const chunkGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(1.3, 1.3, 1.3));
  const scrapChunks: Array<[number, number, number, number, number]> = [
    // x, y, z, yaw, pitch
    [-2.4, 0.7, 3.2, 0.5, 0.3],
    [-1.2, 0.6, 4.0, 1.1, -0.2],
    [-3.0, 0.6, 4.2, 0.2, 0.4],
    [-1.8, 1.5, 3.6, 0.8, 0.6],
  ];
  for (const [cx, cy, cz, yaw, pitch] of scrapChunks) {
    const chunk = new THREE.Mesh(chunkGeo, carN % 2 ? metal : darkMetal);
    carN++;
    chunk.position.set(cx, cy, cz);
    chunk.rotation.set(pitch, yaw, pitch * 0.5);
    group.add(chunk);
  }
  const coneGeo: THREE.ConeGeometry = track(new THREE.ConeGeometry(1.1, 2.2, 6));
  const cone = new THREE.Mesh(coneGeo, darkMetal);
  cone.position.set(-4.2, 1.1, 3.6);
  cone.rotation.z = 0.25;
  group.add(cone);

  // ---- magnet crane over the fresh pile ----
  const CRANE_X = 3;
  const postGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.6, 12, 0.6));
  const postPX = new THREE.Mesh(postGeo, darkMetal);
  postPX.position.set(11, 6, -2);
  group.add(postPX);
  const postNX = new THREE.Mesh(postGeo, darkMetal);
  postNX.position.set(-11, 6, -2);
  group.add(postNX);

  // diagonal cross-brace on each post for an industrial-truss look
  const braceGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.15, 6.5, 0.15));
  const bracePX = new THREE.Mesh(braceGeo, metal);
  bracePX.rotation.z = Math.PI / 5;
  bracePX.position.set(11, 8.5, -2);
  group.add(bracePX);
  const braceNX = new THREE.Mesh(braceGeo, metal);
  braceNX.rotation.z = -Math.PI / 5;
  braceNX.position.set(-11, 8.5, -2);
  group.add(braceNX);

  const beamGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(22.6, 0.8, 0.8));
  const beam = new THREE.Mesh(beamGeo, darkMetal);
  beam.position.set(0, 12, -2);
  group.add(beam);

  // beam-edge neon strip so the crane silhouette reads at night
  const beamStripGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(22.6, 0.1, 0.1));
  const beamStrip = new THREE.Mesh(beamStripGeo, neon);
  beamStrip.position.set(0, 12.42, -2);
  group.add(beamStrip);

  // hanging electromagnet — a group pivoting at the beam so animate() can swing it like a pendulum
  const magnetArm = new THREE.Group();
  magnetArm.position.set(CRANE_X, 12, -2);
  group.add(magnetArm);

  const cableGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.07, 0.07, 4, 8));
  const cable = new THREE.Mesh(cableGeo, darkMetal);
  cable.position.set(0, -2, 0);
  magnetArm.add(cable);

  // the magnet disc: a squat cylinder with a bright neon rim under it
  const magnetGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(1.7, 1.9, 1.1, 20));
  const magnet = new THREE.Mesh(magnetGeo, darkMetal);
  magnet.position.set(0, -4.6, 0);
  magnetArm.add(magnet);
  const magnetRimGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(1.95, 1.95, 0.25, 20));
  const magnetRim = new THREE.Mesh(magnetRimGeo, neon);
  magnetRim.position.set(0, -5.15, 0);
  magnetArm.add(magnetRim);

  // ---- hazard stripes on the ground near the front, alternating neon / darkTrim ----
  const stripeGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(3, 0.06, 0.7));
  const stripeCount = 7;
  for (let i = 0; i < stripeCount; i++) {
    const mat = i % 2 === 0 ? neon : darkTrim;
    const stripe = new THREE.Mesh(stripeGeo, mat);
    stripe.rotation.y = Math.PI / 5;
    stripe.position.set(-7.2 + i * 2.4, 0.06, HALF_Z - 1.2);
    group.add(stripe);
  }

  // ---- slow-blinking hazard beacon on a pole by the front-corner gatepost ----
  const beaconMat: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffb020, emissiveIntensity: 1.6 }),
  );
  const poleGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.25, 5, 0.25));
  const pole = new THREE.Mesh(poleGeo, darkMetal);
  pole.position.set(-11.5, 2.5, HALF_Z - 0.5);
  group.add(pole);
  const beaconGeo: THREE.SphereGeometry = track(new THREE.SphereGeometry(0.5, 12, 10));
  const beacon = new THREE.Mesh(beaconGeo, beaconMat);
  beacon.position.set(-11.5, 5.2, HALF_Z - 0.5);
  group.add(beacon);

  // ---- animation: swing the magnet, pulse the roofline neon, blink the beacon ----
  const animate = (t: number): void => {
    magnetArm.rotation.z = Math.sin(t * 0.8) * 0.13;        // gentle pendulum over the pile
    magnetArm.rotation.x = Math.cos(t * 0.55) * 0.05;
    neon.emissiveIntensity = 1.5 + 0.35 * Math.sin(t * 1.6); // shed/crane neon breathes
    beaconMat.emissiveIntensity = 0.5 + 1.6 * Math.pow(0.5 + 0.5 * Math.sin(t * 2.2), 6); // sharp blink
  };

  return { group, signY: 15, frontZ: HALF_Z, animate };
}
