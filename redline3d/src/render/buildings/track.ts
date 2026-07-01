import * as THREE from "three";
import type { Track, BuiltBuilding } from "./types";

/** Number of start-light spheres in the light tree, and the F1-style sequence length. */
const LIGHT_COUNT = 5;
/** Seconds each light stays lit before the next one joins, then the whole tree resets. */
const STEP_SECONDS = 0.6;
/** How long the tree stays fully lit before resetting to dark. */
const HOLD_SECONDS = 0.8;

const IDLE_INTENSITY = 0.15;
const LIT_INTENSITY = 2.2;

export function buildTrack(color: number, track: Track): BuiltBuilding {
  const group = new THREE.Group();

  // ---- shared materials (created once, reused across meshes) ----
  const body = track(
    new THREE.MeshStandardMaterial({
      color: 0x120a28,
      emissive: color,
      emissiveIntensity: 0.16,
      metalness: 0.4,
      roughness: 0.55,
    })
  );
  const darkTrim = track(
    new THREE.MeshStandardMaterial({ color: 0x0a0820, metalness: 0.5, roughness: 0.5 })
  );
  const neon = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 })
  );
  const darkMetal = track(
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.7, roughness: 0.5 })
  );
  // Separate (but still shared-among-themselves) neon material for the banner checker,
  // so its animated pulse doesn't bleed into the finish stripe / spectator dots above.
  const bannerNeon = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 })
  );

  // ---- shared geometries ----
  const pillarGeo = track(new THREE.BoxGeometry(1.6, 13, 1.6));
  const beamGeo = track(new THREE.BoxGeometry(26, 1, 1.2));
  const checkerBoxGeo = track(new THREE.BoxGeometry(1.6, 0.9, 0.15));
  const stripeBoxGeo = track(new THREE.BoxGeometry(1.4, 0.12, 1.4));
  const lightPostGeo = track(new THREE.CylinderGeometry(0.14, 0.14, 7, 8));
  const lightSphereGeo = track(new THREE.SphereGeometry(0.32, 12, 10));
  const seatStepGeo = track(new THREE.BoxGeometry(28, 1, 1.6));
  const roofSlabGeo = track(new THREE.BoxGeometry(20, 0.25, 2));
  const roofPostGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 3, 8));
  const spectatorGeo = track(new THREE.SphereGeometry(0.16, 8, 6));

  // ================= GATE PILLARS =================
  const pillarL = new THREE.Mesh(pillarGeo, body);
  pillarL.position.set(-12, 6.5, 4);
  group.add(pillarL);

  const pillarR = new THREE.Mesh(pillarGeo, body);
  pillarR.position.set(12, 6.5, 4);
  group.add(pillarR);

  // ================= BANNER BEAM =================
  const beam = new THREE.Mesh(beamGeo, body);
  beam.position.set(0, 13, 4);
  group.add(beam);

  // Checkered strip mounted on the beam's +Z face (~12 boxes alternating neon/darkTrim).
  const CHECKER_COUNT = 12;
  const checkerSpan = 24; // slightly inset from the 26-wide beam
  for (let i = 0; i < CHECKER_COUNT; i++) {
    const mat = i % 2 === 0 ? bannerNeon : darkTrim;
    const box = new THREE.Mesh(checkerBoxGeo, mat);
    const x = -checkerSpan / 2 + (i + 0.5) * (checkerSpan / CHECKER_COUNT);
    box.position.set(x, 13, 4.68);
    group.add(box);
  }

  // ================= FINISH STRIPE (ground) =================
  const STRIPE_COUNT = 8;
  const stripeSpan = 20;
  for (let i = 0; i < STRIPE_COUNT; i++) {
    const mat = i % 2 === 0 ? neon : darkTrim;
    const box = new THREE.Mesh(stripeBoxGeo, mat);
    const x = -stripeSpan / 2 + (i + 0.5) * (stripeSpan / STRIPE_COUNT);
    box.position.set(x, 0.06, 5);
    group.add(box);
  }

  // ================= GRANDSTAND (behind the gate, -Z side) =================
  const TIER_COUNT = 4;
  for (let i = 0; i < TIER_COUNT; i++) {
    const seat = new THREE.Mesh(seatStepGeo, body);
    const z = -1.5 - i * 1.5; // steps back from -1.5 to -6
    const y = 0.6 + i * 1.4; // rises with each tier
    seat.position.set(0, y, z);
    group.add(seat);
  }

  // Thin roof slab over the top tier on two short posts.
  const topTierZ = -1.5 - (TIER_COUNT - 1) * 1.5;
  const topTierY = 0.6 + (TIER_COUNT - 1) * 1.4;
  const roofY = topTierY + 1.6 + 3; // sits above the seat top, posts span the gap
  const postY = topTierY + 1.6 + 1.5;

  const roofPostL = new THREE.Mesh(roofPostGeo, darkTrim);
  roofPostL.position.set(-8, postY, topTierZ);
  group.add(roofPostL);

  const roofPostR = new THREE.Mesh(roofPostGeo, darkTrim);
  roofPostR.position.set(8, postY, topTierZ);
  group.add(roofPostR);

  const roofSlab = new THREE.Mesh(roofSlabGeo, darkTrim);
  roofSlab.position.set(0, roofY, topTierZ);
  group.add(roofSlab);

  // A handful of tiny neon dots as spectators, scattered on the top tiers.
  const SPECTATOR_COUNT = 4;
  for (let i = 0; i < SPECTATOR_COUNT; i++) {
    const tier = 2 + (i % 2); // sit on the two rearmost tiers
    const z = -1.5 - tier * 1.5;
    const y = 0.6 + tier * 1.4 + 0.65;
    const x = -10 + (i / (SPECTATOR_COUNT - 1)) * 20;
    const dot = new THREE.Mesh(spectatorGeo, neon);
    dot.position.set(x, y, z);
    group.add(dot);
  }

  // ================= START-LIGHT TREE (beside the +X pillar) =================
  const lightPost = new THREE.Mesh(lightPostGeo, darkMetal);
  lightPost.position.set(13.4, 3.5, 4);
  group.add(lightPost);

  const lightMaterials: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const mat = track(
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: IDLE_INTENSITY })
    );
    lightMaterials.push(mat);
    const sphere = new THREE.Mesh(lightSphereGeo, mat);
    // stack from ~y=2 up to ~y=6.4 along the post
    const y = 2 + (i * 4.4) / (LIGHT_COUNT - 1);
    sphere.position.set(13.4, y, 4.55);
    group.add(sphere);
  }

  // ================= ANIMATE =================
  const cycleSeconds = LIGHT_COUNT * STEP_SECONDS + HOLD_SECONDS;

  const animate = (t: number): void => {
    const phase = t % cycleSeconds;
    // F1-style sequence: light up one-by-one, then hold fully lit, then reset (via modulo wrap).
    const litCount = Math.min(LIGHT_COUNT, Math.floor(phase / STEP_SECONDS) + 1);
    for (let i = 0; i < LIGHT_COUNT; i++) {
      lightMaterials[i].emissiveIntensity = i < litCount ? LIT_INTENSITY : IDLE_INTENSITY;
    }

    // Subtle pulse on the banner checker neon.
    bannerNeon.emissiveIntensity = 1.5 + Math.sin(t * 2.2) * 0.35;
  };

  return { group, signY: 17, frontZ: 6, animate };
}
