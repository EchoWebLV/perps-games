import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { tagTexture } from "./stripcars";
import { buildWheelRig, type WheelRig } from "./wheels";
import { toonify } from "./toon";
import { makeBlobShadow } from "./blob-shadow";

/**
 * Ambient cruisers — a couple of cars slowly lapping the plaza so the strip never reads
 * frozen. Pure spline-followers on an ellipse threaded between the parked meet and the
 * building arc (no AI, no physics, no interaction). Capped at two for the Seeker GPU.
 * An optional gamertag rides above each one — same pill as the parked meet.
 */

export interface CruiserSpec { url: string; scale?: number; yaw?: number; tag?: string; color?: string }
export interface Cruisers {
  group: THREE.Group;
  /** fetch the cruiser GLBs — deferred + sequential, same contract as StripCars.load()
   *  (constructor loads nothing; the tags lap the plaza alone until the cars stream in) */
  load(prepare?: (model: THREE.Object3D) => Promise<unknown>): Promise<void>;
  update(dt: number): void;
  /** low-tier distance cull, same contract as StripCars.cull(): hide a whole cruiser
   *  (car + tag) beyond maxDist of the player — update() keeps moving it while hidden,
   *  so it re-enters the lap seamlessly when it comes back in range */
  cull(x: number, z: number, maxDist: number): void;
  dispose(): void;
}

// the lap: cruisers circle the plaza on the loop road — an ellipse at the loop centreline,
// inside the door rings and clear of the parked meet + spawn mouth (all asserted by
// cruisers.test.ts). Reads as traffic going round the town-square roundabout.
export const LAP = { cx: 0, cz: 0, rx: 60, rz: 60 };
const SPEED = 12;            // world units/sec along the lap (brisk cruise — 33% quicker than the old 9)
const TARGET_LEN = 11.23;    // same footprint normalization as every other car
const MODEL_YAW = Math.PI;

/** position + facing on the lap at parameter theta — exported for tests */
export function cruiserPose(theta: number): { x: number; z: number; rot: number } {
  const x = LAP.cx + LAP.rx * Math.cos(theta);
  const z = LAP.cz + LAP.rz * Math.sin(theta);
  // tangent (counterclockwise): d/dθ = (-rx sinθ, rz cosθ); model noses -Z at rot 0,
  // so rot = atan2(-vx, -vz) points the nose along the velocity
  const vx = -LAP.rx * Math.sin(theta), vz = LAP.rz * Math.cos(theta);
  return { x, z, rot: Math.atan2(-vx, -vz) };
}

export function createCruisers(specs: CruiserSpec[]): Cruisers {
  const group = new THREE.Group();
  const loader = new GLTFLoader();
  const jobs: Array<(prepare?: (model: THREE.Object3D) => Promise<unknown>) => Promise<void>> = [];

  const anchors: Array<{ node: THREE.Group; theta: number; rig: WheelRig | null }> = [];
  specs.slice(0, 2).forEach((spec, i) => {
    const anchor = new THREE.Group();
    group.add(anchor);
    anchor.add(makeBlobShadow(6, 10)); // ground the lapping cruiser (sibling of the toonified model)
    // rig filled in once the GLB streams in (null until then, and for wheel-less models like the magnet)
    const entry = { node: anchor, theta: i * Math.PI, rig: null as WheelRig | null };
    anchors.push(entry); // opposite sides of the lap

    // optional floating gamertag — child of the anchor, so it rides the moving car
    let tagSprite: THREE.Sprite | null = null;
    if (spec.tag) {
      tagSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tagTexture(spec.tag, spec.color ?? "#27e7ff"),
        transparent: true, depthWrite: false,
      }));
      tagSprite.scale.set(9, 2.25, 1);
      tagSprite.position.y = 6.4; // default until the model's real height is known
      anchor.add(tagSprite);
    }

    // deferred fetch-and-attach (run by load() in slot order — see the interface note)
    jobs.push((prepare) => new Promise<void>((done) => {
      loader.load(spec.url, (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = (TARGET_LEN / (Math.max(size.x, size.z) || 1)) * (spec.scale ?? 1);
        model.scale.setScalar(scale);
        model.rotation.y = MODEL_YAW + (spec.yaw ?? 0);
        const box2 = new THREE.Box3().setFromObject(model);
        const c = box2.getCenter(new THREE.Vector3());
        model.position.set(-c.x, -box2.min.y, -c.z);
        // warm the shaders (best effort), THEN attach — first sight compiles nothing
        const ready = prepare ? prepare(model).catch(() => undefined) : Promise.resolve(undefined);
        void ready.then(() => {
          anchor.add(model);
          // float the tag clear of THIS cruiser's roofline (magnet is tall, the cart is squat)
          if (tagSprite) tagSprite.position.y = Math.max(6.4, box2.max.y - box2.min.y + 2.2);
          // wheel roll: build the rig at the anchor's canonical (unyawed) pose so the forward-roll
          // SIGN is read against the car body (the model noses -Z at rot 0); update() re-yaws next frame.
          const savedRot = anchor.rotation.y;
          anchor.rotation.y = 0;
          anchor.updateMatrixWorld(true);
          entry.rig = buildWheelRig(model, scale, { probe: false }); // null when the GLB has no rigged wheels
          anchor.rotation.y = savedRot;
          toonify(model); // cel-shade + outline (after rig so wheel lookup is unaffected)
          done();
        });
      }, undefined, (err) => { console.warn("[cruisers] GLB failed:", spec.url, err); done(); });
    }));
  });

  // angular speed varies with local radius; a mean-radius approximation keeps the pace
  // visually constant without arc-length integration
  const w = SPEED / ((LAP.rx + LAP.rz) / 2);

  let loading: Promise<void> | null = null;
  return {
    group,
    load(prepare) {
      return (loading ??= (async () => { for (const job of jobs) await job(prepare); })());
    },
    update(dt) {
      for (const a of anchors) {
        a.theta += w * dt;
        const p = cruiserPose(a.theta);
        a.node.position.set(p.x, 0, p.z);
        a.node.rotation.y = p.rot;
        a.rig?.spin(dt, SPEED); // roll the wheels at the lap's linear speed (circle → constant = SPEED)
      }
    },
    cull(x, z, maxDist) {
      const d2 = maxDist * maxDist;
      for (const a of anchors) {
        const dx = a.node.position.x - x, dz = a.node.position.z - z;
        a.node.visible = dx * dx + dz * dz <= d2;
      }
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose());
        }
        const s = o as THREE.Sprite; // gamertag sprites: free the canvas texture + material
        if (s.isSprite) { s.material?.map?.dispose(); s.material?.dispose(); }
      });
    },
  };
}
