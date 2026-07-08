import * as THREE from "three";
import type { BuiltBuilding, Track } from "./types";

/** Tall stepped "level-up" lab tower — a ziggurat of narrowing tiers. Front (+Z) carries a big
 *  neon up-arrow, a row of blinking lab lights, and a rooftop beacon antenna. */
export function buildUpgrades(color: number, track: Track): BuiltBuilding {
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
  const darkMetal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.7, roughness: 0.5 }),
  );
  // dedicated material for the lab-light row / beacon so their pulse can be driven independent of `neon`
  const labLight: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );
  const beacon: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );

  const group = new THREE.Group();

  // ---- tier geometry constants (ziggurat narrowing upward) ----
  const TIER1_W = 20;
  const TIER1_H = 8;
  const TIER1_Y0 = 0;
  const TIER1_Y1 = TIER1_Y0 + TIER1_H; // 8

  const TIER2_W = 14;
  const TIER2_H = 8;
  const TIER2_Y0 = TIER1_Y1; // 8
  const TIER2_Y1 = TIER2_Y0 + TIER2_H; // 16

  const TIER3_W = 8;
  const TIER3_H = 8;
  const TIER3_Y0 = TIER2_Y1; // 16
  const TIER3_Y1 = TIER3_Y0 + TIER3_H; // 24

  const FRONT_Z = TIER1_W / 2; // 10 — the declared frontZ

  // ---- three stacked tiers ----
  const tier1Geo: THREE.BoxGeometry = track(new THREE.BoxGeometry(TIER1_W, TIER1_H, TIER1_W));
  const tier1 = new THREE.Mesh(tier1Geo, body);
  tier1.position.set(0, TIER1_Y0 + TIER1_H / 2, 0);
  group.add(tier1);

  const tier2Geo: THREE.BoxGeometry = track(new THREE.BoxGeometry(TIER2_W, TIER2_H, TIER2_W));
  const tier2 = new THREE.Mesh(tier2Geo, body);
  tier2.position.set(0, TIER2_Y0 + TIER2_H / 2, 0);
  group.add(tier2);

  const tier3Geo: THREE.BoxGeometry = track(new THREE.BoxGeometry(TIER3_W, TIER3_H, TIER3_W));
  const tier3 = new THREE.Mesh(tier3Geo, body);
  tier3.position.set(0, TIER3_Y0 + TIER3_H / 2, 0);
  group.add(tier3);

  // ---- neon seam rings around the top edge of each tier (4 thin boxes forming a frame) ----
  const SEAM_T = 0.35; // seam bar thickness/height
  const addSeamRing = (w: number, y: number): void => {
    const longGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(w, SEAM_T, SEAM_T));
    const shortGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(SEAM_T, SEAM_T, w));
    const half = w / 2;
    const front = new THREE.Mesh(longGeo, neon);
    front.position.set(0, y, half);
    group.add(front);
    const back = new THREE.Mesh(longGeo, neon);
    back.position.set(0, y, -half);
    group.add(back);
    const right = new THREE.Mesh(shortGeo, neon);
    right.position.set(half, y, 0);
    group.add(right);
    const left = new THREE.Mesh(shortGeo, neon);
    left.position.set(-half, y, 0);
    group.add(left);
  };
  addSeamRing(TIER1_W, TIER1_Y1);
  addSeamRing(TIER2_W, TIER2_Y1);
  addSeamRing(TIER3_W, TIER3_Y1);

  // ---- big up-arrow on the +Z front face, spanning tier1-tier2 ----
  // The whole arrow rides a "level up" loop: it climbs the face and fades out at the top,
  // so it needs its own transparent material + a group to translate.
  const ARROW_Z = FRONT_Z + 0.15; // proud of tier1's front face
  const arrowMat: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5, transparent: true }),
  );
  const arrow = new THREE.Group();
  const shaftGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(2.2, 8, 0.3));
  const shaft = new THREE.Mesh(shaftGeo, arrowMat);
  shaft.position.set(0, 6, ARROW_Z);
  arrow.add(shaft);

  // arrowhead: a 4-sided cone (flat-faced pyramid), apex up, rotated 45° so an edge faces forward
  const headGeo: THREE.ConeGeometry = track(new THREE.ConeGeometry(3.2, 4.5, 4));
  const head = new THREE.Mesh(headGeo, arrowMat);
  head.rotation.y = Math.PI / 4;
  head.position.set(0, 12.25, ARROW_Z);
  arrow.add(head);
  group.add(arrow);

  // ---- rooftop antenna on tier3: darkMetal mast + neon beacon sphere ----
  const MAST_H = 5;
  const mastGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.18, 0.22, MAST_H, 8));
  const mast = new THREE.Mesh(mastGeo, darkMetal);
  mast.position.set(0, TIER3_Y1 + MAST_H / 2, 0);
  group.add(mast);

  const beaconGeo: THREE.SphereGeometry = track(new THREE.SphereGeometry(0.55, 12, 12));
  const beaconMesh = new THREE.Mesh(beaconGeo, beacon);
  beaconMesh.position.set(0, TIER3_Y1 + MAST_H + 0.4, 0);
  group.add(beaconMesh);

  // ---- row of 5 lab lights on the +Z front of tier1 ----
  const LAB_LIGHT_Y = 4.2;
  const LAB_LIGHT_Z = FRONT_Z + 0.1;
  const labLightGeo: THREE.SphereGeometry = track(new THREE.SphereGeometry(0.4, 10, 10));
  const labLightMeshes: THREE.Mesh[] = [];
  const labLightCount = 5;
  const labLightSpan = 12; // spread across the front face, within the 20-wide tier1
  for (let i = 0; i < labLightCount; i++) {
    const x = -labLightSpan / 2 + (labLightSpan * i) / (labLightCount - 1);
    const lightMesh = new THREE.Mesh(labLightGeo, labLight);
    lightMesh.position.set(x, LAB_LIGHT_Y, LAB_LIGHT_Z);
    group.add(lightMesh);
    labLightMeshes.push(lightMesh);
  }

  // ---- side vents on the ±X faces of tier1 ----
  const ventGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.25, 1.4, 2.4));
  const ventOffsets: number[] = [-5, 0, 5];
  const ventX = TIER1_W / 2 + 0.1;
  for (const vz of ventOffsets) {
    const ventPX = new THREE.Mesh(ventGeo, darkTrim);
    ventPX.position.set(ventX, 5.5, vz);
    group.add(ventPX);
    const ventNX = new THREE.Mesh(ventGeo, darkTrim);
    ventNX.position.set(-ventX, 5.5, vz);
    group.add(ventNX);
  }

  // ---- blink / pulse animation ----
  const labLightMaterials: THREE.MeshStandardMaterial[] = labLightMeshes.map(
    (m) => m.material as THREE.MeshStandardMaterial,
  );
  const labLightPhases: number[] = labLightMaterials.map((_, i) => (i * Math.PI * 2) / labLightCount);
  const ARROW_CYCLE = 2.4; // seconds per "level up": climb the face, fade out near the top
  const ARROW_RISE = 3.4;
  const animate = (t: number): void => {
    for (let i = 0; i < labLightMaterials.length; i++) {
      // out-of-phase blink: mostly on, snapping dim on a short duty cycle per light
      const phase = t * 3 + labLightPhases[i];
      const wave = Math.sin(phase);
      labLightMaterials[i].emissiveIntensity = wave > 0.6 ? 0.15 : 1.6;
    }
    beacon.emissiveIntensity = 1.1 + 0.9 * Math.sin(t * 2.2);
    const ph = (t % ARROW_CYCLE) / ARROW_CYCLE;
    arrow.position.y = ph * ph * ARROW_RISE; // ease-in climb
    arrowMat.opacity = ph < 0.7 ? 1 : 1 - (ph - 0.7) / 0.3;
  };

  return { group, signY: 27, frontZ: FRONT_Z, animate };
}
