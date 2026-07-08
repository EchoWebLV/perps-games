import * as THREE from "three";
import type { BuiltBuilding, Track } from "./types";

/** Open car-bay / workshop building. Front (+Z) is the open bay opening. */
export function buildGarage(color: number, track: Track): BuiltBuilding {
  // ---- shared materials (create once, reuse across meshes) ----
  const body: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({
      color: 0x120a28,
      emissive: color,
      emissiveIntensity: 0.16,
      metalness: 0.4,
      roughness: 0.55,
    }),
  );
  const darkTrim: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.5, roughness: 0.5 }),
  );
  const neon: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );
  // The parked car's paint. Kept LOW-metalness with a faint self-glow: a high-metalness material
  // has nothing to reflect inside the shadowed bay (no env map) and renders near-black, so the car
  // vanished. This lighter, softly-lit paint keeps the car readable in the dark interior.
  const metal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0xc2cad8, emissive: color, emissiveIntensity: 0.08, metalness: 0.35, roughness: 0.55 }),
  );
  const darkMetal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.7, roughness: 0.5 }),
  );
  // slightly-emissive door slats — a dedicated material so it can be tuned independent of `neon`
  const slat: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({
      color: 0x0a0820,
      emissive: color,
      emissiveIntensity: 0.5,
      metalness: 0.5,
      roughness: 0.5,
    }),
  );

  const group = new THREE.Group();

  const HALF_X = 13;
  const HALF_Z = 8;
  const WALL_H = 11;
  const WALL_T = 0.6;

  // ---- floor slab ----
  const floorGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, 0.1, 16));
  const floor = new THREE.Mesh(floorGeo, darkTrim);
  floor.position.set(0, 0.05, 0);
  group.add(floor);

  // ---- back wall (−Z) ----
  const backWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, WALL_H, WALL_T));
  const backWall = new THREE.Mesh(backWallGeo, body);
  backWall.position.set(0, WALL_H / 2, -HALF_Z + WALL_T / 2);
  group.add(backWall);

  // ---- side walls (+X / −X), leaving the +Z front fully open ----
  const sideWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(WALL_T, WALL_H, 16));
  const sideWallPX = new THREE.Mesh(sideWallGeo, body);
  sideWallPX.position.set(HALF_X - WALL_T / 2, WALL_H / 2, 0);
  group.add(sideWallPX);
  const sideWallNX = new THREE.Mesh(sideWallGeo, body);
  sideWallNX.position.set(-HALF_X + WALL_T / 2, WALL_H / 2, 0);
  group.add(sideWallNX);

  // ---- flat roof slab ----
  const roofGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, 0.6, 16));
  const roof = new THREE.Mesh(roofGeo, body);
  roof.position.set(0, WALL_H + 0.3, 0);
  group.add(roof);

  // ---- neon lintel beam across the top of the front opening ----
  const lintelGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, 0.8, 0.4));
  const lintel = new THREE.Mesh(lintelGeo, neon);
  lintel.position.set(0, 10, HALF_Z);
  group.add(lintel);

  // ---- roll-up door slats, raised near the roof, spanning the opening ----
  const slatGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(24.5, 0.4, 0.25));
  const slatLower = new THREE.Mesh(slatGeo, slat);
  slatLower.position.set(0, 9.3, HALF_Z - 0.2);
  group.add(slatLower);
  const slatUpper = new THREE.Mesh(slatGeo, slat);
  slatUpper.position.set(0, 9.8, HALF_Z - 0.2);
  group.add(slatUpper);

  // ---- parked car, centered, facing +Z ----
  const carBodyGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(3, 1.4, 6));
  const carBody = new THREE.Mesh(carBodyGeo, metal);
  carBody.position.set(0, 0.05 + 0.7, 0);
  group.add(carBody);

  const carCabinGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(2.2, 0.9, 2.6));
  const carCabin = new THREE.Mesh(carCabinGeo, metal);
  carCabin.position.set(0, 0.05 + 1.4 + 0.45, -0.3);
  group.add(carCabin);

  // wheels: cylinders rotated so the round face points along x (rolls along x-axis)
  const wheelGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 16));
  const wheelPositions: Array<[number, number]> = [
    [1.55, 2.1],
    [-1.55, 2.1],
    [1.55, -2.1],
    [-1.55, -2.1],
  ];
  for (const [wx, wz] of wheelPositions) {
    const wheel = new THREE.Mesh(wheelGeo, darkMetal);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.05 + 0.55, wz);
    group.add(wheel);
  }

  // underglow strip beneath the car
  const underglowGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(3, 0.08, 6));
  const underglow = new THREE.Mesh(underglowGeo, neon);
  underglow.position.set(0, 0.05 + 0.05, 0);
  group.add(underglow);

  // ---- greebles ----

  // tool board on the +X inner wall: a backing rect + a few small neon/darkMetal rects
  const toolBoardBackingGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.1, 2.4, 3.2));
  const toolBoardBacking = new THREE.Mesh(toolBoardBackingGeo, darkMetal);
  toolBoardBacking.position.set(HALF_X - WALL_T - 0.1, 6, 3);
  group.add(toolBoardBacking);

  const toolRectGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.06, 0.5, 0.9));
  const toolPositions: Array<[number, number]> = [
    [6.4, 1.8],
    [5.4, 3.2],
    [6.7, 3.6],
  ];
  for (let i = 0; i < toolPositions.length; i++) {
    const [ty, tz] = toolPositions[i];
    const mat = i % 2 === 0 ? neon : darkMetal;
    const toolRect = new THREE.Mesh(toolRectGeo, mat);
    toolRect.position.set(HALF_X - WALL_T - 0.16, ty, tz);
    group.add(toolRect);
  }

  // tire stack in a back corner (−X, −Z): 3 stacked short cylinders
  const tireGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.6, 0.6, 0.35, 16));
  const tireCornerX = -HALF_X + 1.6;
  const tireCornerZ = -HALF_Z + 1.6;
  for (let i = 0; i < 3; i++) {
    const tire = new THREE.Mesh(tireGeo, darkMetal);
    tire.rotation.x = Math.PI / 2;
    tire.position.set(tireCornerX, 0.05 + 0.35 * i + 0.175, tireCornerZ);
    group.add(tire);
  }

  // charge/fuel pump beside the door on +X at the front: darkMetal box + thin neon "hose" cylinder
  const pumpBaseGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.8, 1.6, 0.6));
  const pumpBase = new THREE.Mesh(pumpBaseGeo, darkMetal);
  const pumpX = HALF_X - 1.4;
  const pumpZ = HALF_Z - 1.2;
  pumpBase.position.set(pumpX, 0.05 + 0.8, pumpZ);
  group.add(pumpBase);

  const hoseGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8));
  const hose = new THREE.Mesh(hoseGeo, neon);
  hose.rotation.z = Math.PI / 4;
  hose.position.set(pumpX - 0.5, 0.05 + 1.3, pumpZ);
  group.add(hose);

  // roof-edge neon strips running front-to-back along the top side edges
  const roofStripGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.2, 0.15, 15.6));
  const roofStripPX = new THREE.Mesh(roofStripGeo, neon);
  roofStripPX.position.set(HALF_X - 0.3, WALL_H + 0.05, 0);
  group.add(roofStripPX);
  const roofStripNX = new THREE.Mesh(roofStripGeo, neon);
  roofStripNX.position.set(-HALF_X + 0.3, WALL_H + 0.05, 0);
  group.add(roofStripNX);

  // ---- rooftop hologram: a wireframe ghost car slowly turning on a beam of light ----
  const holoMat: THREE.MeshBasicMaterial = track(
    new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  const holo = new THREE.Group();
  const holoBody = new THREE.Mesh(carBodyGeo, holoMat); // reuse the parked car's geometry
  holo.add(holoBody);
  const holoCabin = new THREE.Mesh(carCabinGeo, holoMat);
  holoCabin.position.set(0, 1.15, -0.3);
  holo.add(holoCabin);
  // parked off-centre on the roof so it doesn't hide behind the floating name sign
  const HOLO_X = -7.5;
  const HOLO_Y = WALL_H + 3.2;
  holo.position.set(HOLO_X, HOLO_Y, 0);
  group.add(holo);

  // faint projector beam from the roof up into the hologram
  const holoBeamMat: THREE.MeshBasicMaterial = track(
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  const holoBeamGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(2.4, 0.5, 3.4, 12, 1, true));
  const holoBeam = new THREE.Mesh(holoBeamGeo, holoBeamMat);
  holoBeam.position.set(HOLO_X, WALL_H + 1.9, 0);
  group.add(holoBeam);

  // ---- subtle pulse animation ----
  const pulseMaterials: THREE.MeshStandardMaterial[] = [roofStripPX, roofStripNX, underglow].map(
    (m) => m.material as THREE.MeshStandardMaterial,
  );
  const animate = (t: number): void => {
    const pulse = 1.45 + 0.35 * Math.sin(t * 1.6);
    for (const m of pulseMaterials) {
      m.emissiveIntensity = pulse;
    }
    // the hologram turns, bobs and shimmers like a projection
    holo.rotation.y = t * 0.7;
    holo.position.y = HOLO_Y + 0.35 * Math.sin(t * 1.3);
    holoMat.opacity = 0.24 + 0.1 * Math.sin(t * 2.7) + 0.04 * Math.sin(t * 11);
    holoBeamMat.opacity = 0.08 + 0.04 * Math.sin(t * 2.7);
  };

  return { group, signY: 15, frontZ: 8, animate };
}
