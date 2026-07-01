import * as THREE from "three";
import type { BuiltBuilding, Track } from "./types";

/** Shipping-container yard with a hero loot crate and a gantry crane. Front (+Z) is the yard opening. */
export function buildCrates(color: number, track: Track): BuiltBuilding {
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
  const metal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0xaab2bd, metalness: 0.9, roughness: 0.4 }),
  );
  const darkMetal: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 0.7, roughness: 0.5 }),
  );
  // Shipping-container bodies: two mid-tone steel-violet shades (with a faint self-glow) so the
  // stacked boxes actually read against the near-black lot instead of collapsing into dark voids.
  const containerA: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x33264d, emissive: color, emissiveIntensity: 0.12, metalness: 0.5, roughness: 0.5 }),
  );
  const containerB: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color: 0x4a3663, emissive: color, emissiveIntensity: 0.12, metalness: 0.5, roughness: 0.5 }),
  );
  // dedicated seam material for the hero crate so its pulse can be tuned independent of `neon`
  const seam: THREE.MeshStandardMaterial = track(
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5 }),
  );

  const group = new THREE.Group();

  const HALF_X = 13;
  const HALF_Z = 9;
  const WALL_H = 11;
  const WALL_T = 0.6;

  // ---- floor slab ----
  const floorGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, 0.1, 18));
  const floor = new THREE.Mesh(floorGeo, darkTrim);
  floor.position.set(0, 0.05, 0);
  group.add(floor);

  // ---- back warehouse wall (−Z) ----
  const backWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(26, WALL_H, WALL_T));
  const backWall = new THREE.Mesh(backWallGeo, body);
  backWall.position.set(0, WALL_H / 2, -HALF_Z + WALL_T / 2);
  group.add(backWall);

  // ---- partial side wall (+X only — the −X side stays open to the yard) ----
  const sideWallGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(WALL_T, WALL_H, 18));
  const sideWallPX = new THREE.Mesh(sideWallGeo, body);
  sideWallPX.position.set(HALF_X - WALL_T / 2, WALL_H / 2, 0);
  group.add(sideWallPX);

  // roofline neon strip along the back wall top edge, reads as a warehouse silhouette
  const backStripGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(25.6, 0.15, 0.2));
  const backStrip = new THREE.Mesh(backStripGeo, neon);
  backStrip.position.set(0, WALL_H, -HALF_Z + WALL_T);
  group.add(backStrip);

  // ---- shared container geometries ----
  const containerGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(6, 4, 4));
  const ribGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.08, 3.6, 0.3));
  const trimEdgeGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(6.05, 0.12, 0.12));

  /** Places one container box with corrugation ribs + a neon trim edge along its +Z face. */
  function placeContainer(cx: number, cy: number, cz: number, mat: THREE.MeshStandardMaterial): void {
    const box = new THREE.Mesh(containerGeo, mat);
    box.position.set(cx, cy, cz);
    group.add(box);

    // a couple of thin vertical corrugation ribs on the +Z face (dark grooves on the lit box)
    const ribOffsets = [-1.6, 1.6];
    for (const rx of ribOffsets) {
      const rib = new THREE.Mesh(ribGeo, darkTrim);
      rib.position.set(cx + rx, cy, cz + 2.02);
      group.add(rib);
    }

    // neon trim edge along the bottom of the +Z face
    const trim = new THREE.Mesh(trimEdgeGeo, neon);
    trim.position.set(cx, cy - 1.94, cz + 2.05);
    group.add(trim);
  }

  // ---- container pile 1: two on the ground + one stacked on top, toward −X ----
  placeContainer(-8, 2, -3, containerA);
  placeContainer(-8, 2, 2, containerB);
  placeContainer(-8, 6, -0.5, containerB);

  // ---- container pile 2: two on the ground + one stacked on top, toward +X (under the crane beam) ----
  placeContainer(4, 2, -4, containerB);
  placeContainer(4, 2, 0.5, containerA);
  placeContainer(4, 6, -1.75, containerA);

  // ---- hero loot crate, near front-center ----
  const heroCx = 0;
  const heroCy = 2;
  const heroCz = 5;
  const heroSize = 4;

  const heroCrateGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(heroSize, heroSize, heroSize));
  const heroCrate = new THREE.Mesh(heroCrateGeo, body);
  heroCrate.position.set(heroCx, heroCy, heroCz);
  group.add(heroCrate);

  // cross-straps: thin neon boxes forming an X across the +Z face
  const strapLen = Math.SQRT2 * heroSize + 0.2;
  const strapGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.3, strapLen, 0.15));
  const strapZ = heroCz + heroSize / 2 + 0.08;
  const strapA = new THREE.Mesh(strapGeo, neon);
  strapA.rotation.z = Math.PI / 4;
  strapA.position.set(heroCx, heroCy, strapZ);
  group.add(strapA);
  const strapB = new THREE.Mesh(strapGeo, neon);
  strapB.rotation.z = -Math.PI / 4;
  strapB.position.set(heroCx, heroCy, strapZ);
  group.add(strapB);

  // bands over the top of the crate, running +X/−Z to +X/+Z (front-to-back over the roofline)
  const topBandGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.3, 0.15, heroSize + 0.2));
  const topBandOffsets = [-1.2, 1.2];
  for (const ox of topBandOffsets) {
    const band = new THREE.Mesh(topBandGeo, neon);
    band.position.set(heroCx + ox, heroCy + heroSize / 2 + 0.08, heroCz);
    group.add(band);
  }

  // glowing neon seam line around the crate's middle (four edge boxes forming a ring)
  const seamHGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(heroSize + 0.1, 0.2, 0.2));
  const seamVGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.2, 0.2, heroSize + 0.1));
  const seamFront = new THREE.Mesh(seamHGeo, seam);
  seamFront.position.set(heroCx, heroCy, heroCz + heroSize / 2);
  group.add(seamFront);
  const seamBack = new THREE.Mesh(seamHGeo, seam);
  seamBack.position.set(heroCx, heroCy, heroCz - heroSize / 2);
  group.add(seamBack);
  const seamLeft = new THREE.Mesh(seamVGeo, seam);
  seamLeft.position.set(heroCx - heroSize / 2, heroCy, heroCz);
  group.add(seamLeft);
  const seamRight = new THREE.Mesh(seamVGeo, seam);
  seamRight.position.set(heroCx + heroSize / 2, heroCy, heroCz);
  group.add(seamRight);

  // ---- gantry crane over the yard ----
  const postGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.6, 12, 0.6));
  const postPX = new THREE.Mesh(postGeo, darkMetal);
  postPX.position.set(10, 6, -1);
  group.add(postPX);
  const postNX = new THREE.Mesh(postGeo, darkMetal);
  postNX.position.set(-10, 6, -1);
  group.add(postNX);

  // diagonal cross-brace on each post for an industrial-truss look
  const braceGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.15, 6.5, 0.15));
  const bracePX = new THREE.Mesh(braceGeo, metal);
  bracePX.rotation.z = Math.PI / 5;
  bracePX.position.set(10, 8.5, -1);
  group.add(bracePX);
  const braceNX = new THREE.Mesh(braceGeo, metal);
  braceNX.rotation.z = -Math.PI / 5;
  braceNX.position.set(-10, 8.5, -1);
  group.add(braceNX);

  const beamGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(20.6, 0.8, 0.8));
  const beam = new THREE.Mesh(beamGeo, darkMetal);
  beam.position.set(0, 12, -1);
  group.add(beam);

  // beam-edge neon strip so the crane silhouette reads at night
  const beamStripGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(20.6, 0.1, 0.1));
  const beamStrip = new THREE.Mesh(beamStripGeo, neon);
  beamStrip.position.set(0, 12.42, -1);
  group.add(beamStrip);

  // hanging hook: a group so it can be bobbed as one unit in animate()
  const hookGroup = new THREE.Group();
  hookGroup.position.set(0, 0, -1);
  group.add(hookGroup);

  const cableGeo: THREE.CylinderGeometry = track(new THREE.CylinderGeometry(0.06, 0.06, 4.5, 8));
  const cable = new THREE.Mesh(cableGeo, darkMetal);
  cable.position.set(0, 9.35, 0);
  hookGroup.add(cable);

  const hookTipGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(0.4, 0.4, 0.4));
  const hookTip = new THREE.Mesh(hookTipGeo, neon);
  hookTip.position.set(0, 6.9, 0);
  hookGroup.add(hookTip);

  // ---- hazard stripes on the ground near the front, alternating neon / darkTrim ----
  const stripeGeo: THREE.BoxGeometry = track(new THREE.BoxGeometry(3, 0.06, 0.7));
  const stripeCount = 5;
  for (let i = 0; i < stripeCount; i++) {
    const mat = i % 2 === 0 ? neon : darkTrim;
    const stripe = new THREE.Mesh(stripeGeo, mat);
    stripe.rotation.y = Math.PI / 5;
    stripe.position.set(-4.8 + i * 2.4, 0.06, HALF_Z - 1.2);
    group.add(stripe);
  }

  // ---- animation: bob the crane hook, pulse the loot-crate seam ----
  const seamMat = seam;
  const hookBaseY = hookGroup.position.y;
  const animate = (t: number): void => {
    hookGroup.position.y = hookBaseY + Math.sin(t * 1.1) * 0.6;
    seamMat.emissiveIntensity = 1.5 + 0.9 * Math.sin(t * 2.4);
  };

  return { group, signY: 15, frontZ: 9, animate };
}
