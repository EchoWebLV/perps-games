import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { carNormScale } from "./car-scale";

/**
 * Parked hero cars around the strip plaza — the "people meet here" dressing.
 * Each slot holds a real car GLB angled into the loose circle of a car meet, with a
 * floating gamertag sprite and a soft neon puddle underneath. Purely decorative today;
 * the slot + tag structure is exactly what a live-presence feed will occupy later
 * (swap "parked prop" for "remote player" without moving anything).
 */

export interface StripCarSpec {
  /** GLB to park (same registry entries the garage uses) */
  url: string;
  /** per-model footprint multiplier (matches the garage registry's `scale`) */
  scale?: number;
  /** per-model facing tweak in radians (matches the garage registry's `yaw`) */
  yaw?: number;
  /** the floating gamertag */
  tag: string;
  /** neon accent for the tag + ground puddle */
  color: string;
}

export interface StripCars {
  group: THREE.Group;
  /**
   * Fetch the parked cars' GLBs — deliberately NOT started by the constructor. These are
   * heavyweight dressing (~tens of MB each); decoding them during the first seconds of play
   * was a hitch source, so main.ts kicks this off after the first rendered frame. Loads run
   * SEQUENTIALLY (each starts when the previous car is in), smearing decode + GPU uploads
   * over time instead of one burst; the puddles + gamertags mark the bays until then.
   * `prepare` (renderer.compileAsync) warms a model's shaders BEFORE it attaches, so its
   * first on-screen frame pays no compile stall. Repeat calls return the same run.
   */
  load(prepare?: (model: THREE.Object3D) => Promise<unknown>): Promise<void>;
  /** low-tier distance cull: hide whole parked-car anchors (car + tag + puddle) beyond
   *  maxDist of the player at (x,z). Roots only, zero allocation — called per frame by
   *  main.ts on the reduced tier; the full tier never calls it. */
  cull(x: number, z: number, maxDist: number): void;
  dispose(): void;
}

/** On-disk GLB weights (KB, measured 2026-07-08) for the lobby-dressing pool. The low tier
 *  parks only the lightest few — the five heroes plus two cruisers total ~120MB on disk,
 *  the single biggest vertex/texture pile facing the town square on a Mali-class GPU. */
export const DRESSING_KB: Record<string, number> = {
  "/models/skull.glb": 11939,
  "/models/clown-car.glb": 15124,
  "/models/pink-rod.glb": 19697,
  "/models/six-wheeler.glb": 20047,
  "/models/slot-machine.glb": 21664,
  "/models/magnet.glb": 13863,
  "/models/shopping-cart.glb": 17449,
};

/** The n lightest specs by GLB weight, lightest first — the low tier's dressing diet.
 *  Unknown urls rank heaviest so they can never displace a known-light model. Pure
 *  (never mutates `specs`); the picked cars then fill STRIP_SLOTS from slot 0, keeping
 *  the thinned meet flanking the entrance where it reads. */
export function lightestSpecs<T extends { url: string }>(specs: readonly T[], n: number, kb: Record<string, number> = DRESSING_KB): T[] {
  return [...specs].sort((a, b) => (kb[a.url] ?? Infinity) - (kb[b.url] ?? Infinity)).slice(0, n);
}

// Same normalization the player car uses, so a parked Skull is the size of a driven Skull.
const TARGET_LEN = 11.23;
const MODEL_YAW = Math.PI;

/**
 * Parked slots in world coords: a car meet lining the mouth of Main Street, flanking the
 * boot camera's view (player spawns at the south end facing north up the street) so it reads
 * immediately. `rot` is the group yaw (model noses -Z at 0). Chosen clear of the spawn pad,
 * the driving lane, and every door ring — asserted by stripcars.test.ts against the real
 * layout, so a lobby-layout change that drifts a ring into a parked car fails loudly instead
 * of clipping quietly.
 */
export const STRIP_SLOTS: Array<{ x: number; z: number; rot: number }> = [
  // The meet flanks the OPEN south entrance to the plaza — the first thing you see as you drive
  // in — angled toward the square. Clear of the loop road, every door ring, the spawn pad and
  // each other (asserted by stripcars.test.ts). Hugging the entrance keeps them in a narrow
  // portrait frustum on phones.
  { x: 39, z: 123, rot: -0.5 },  // right of the entrance, angled in
  { x: -39, z: 123, rot: 0.5 },  // left of the entrance, angled in
  { x: 81, z: 138, rot: -0.8 },  // outer right of the entrance
  { x: -81, z: 138, rot: 0.8 },  // outer left of the entrance
  { x: -120, z: 108, rot: 1.0 },  // west tail of the meet
];

/** the floating gamertag pill — shared with the ambient cruisers (cruisers.ts) */
export function tagTexture(text: string, css: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  // pill
  const r = 46, w = c.width - 8, h = 92, x = 4, y = 14;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fillStyle = "rgba(9,7,26,0.82)";
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = css;
  g.stroke();
  // name
  g.font = "700 52px 'Chakra Petch', ui-monospace, monospace";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = css; g.shadowBlur = 18;
  g.fillStyle = css;
  g.fillText(text, c.width / 2, y + h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export function createStripCars(specs: StripCarSpec[]): StripCars {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  const loader = new GLTFLoader();
  // one deferred fetch-and-attach job per slot — run in order by load() below
  const jobs: Array<(prepare?: (model: THREE.Object3D) => Promise<unknown>) => Promise<void>> = [];
  const anchors: THREE.Group[] = []; // slot roots — what cull() toggles

  specs.slice(0, STRIP_SLOTS.length).forEach((spec, i) => {
    const slot = STRIP_SLOTS[i];
    const anchor = new THREE.Group();
    anchor.position.set(slot.x, 0, slot.z);
    anchor.rotation.y = slot.rot;
    group.add(anchor);
    anchors.push(anchor);

    // neon puddle under the car — reads "occupied bay" even before the GLB streams in
    const color = new THREE.Color(spec.color);
    const puddle = new THREE.Mesh(
      track(new THREE.CircleGeometry(7.2, 40)),
      track(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })),
    );
    puddle.rotation.x = -Math.PI / 2;
    puddle.position.y = 0.04;
    anchor.add(puddle);

    // gamertag sprite floating over the roofline — the future remote-player nameplate
    const sprite = new THREE.Sprite(track(new THREE.SpriteMaterial({
      map: track(tagTexture(spec.tag, spec.color)),
      transparent: true, depthWrite: false,
    })));
    sprite.scale.set(9, 2.25, 1);
    sprite.position.y = 6.4 + (i % 2) * 1.1; // stagger neighbours so clustered tags don't stack
    anchor.add(sprite);

    // the car itself — same footprint/facing normalization as the driven car. Deferred:
    // the job only FETCHES when load() reaches it (see the interface note on sequencing).
    jobs.push((prepare) => new Promise<void>((done) => {
      loader.load(spec.url, (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.scale.setScalar(carNormScale(size, TARGET_LEN, spec.scale ?? 1));
        model.rotation.y = MODEL_YAW + (spec.yaw ?? 0);
        const box2 = new THREE.Box3().setFromObject(model);
        const c = box2.getCenter(new THREE.Vector3());
        model.position.set(-c.x, -box2.min.y, -c.z);
        // warm the shaders off-screen (best effort), THEN attach — first sight compiles nothing
        const ready = prepare ? prepare(model).catch(() => undefined) : Promise.resolve(undefined);
        void ready.then(() => {
          anchor.add(model);
          // Lift the tag clear of THIS model's real roofline. Cars are normalized by LENGTH, so a
          // tall model (Skull dome, Slot Machine) overshoots the fixed sprite height and swallows
          // its tag — float it just above the scaled roof, keeping short cars at the tuned 6.4 and
          // the neighbour stagger.
          sprite.position.y = Math.max(6.4, box2.max.y - box2.min.y + 2.2) + (i % 2) * 1.1;
          done();
        });
      }, undefined, (err) => { console.warn("[stripcars] GLB failed:", spec.url, err); done(); });
    }));
  });

  let loading: Promise<void> | null = null;
  return {
    group,
    load(prepare) {
      return (loading ??= (async () => { for (const job of jobs) await job(prepare); })());
    },
    cull(x, z, maxDist) {
      const d2 = maxDist * maxDist;
      for (const a of anchors) {
        const dx = a.position.x - x, dz = a.position.z - z;
        a.visible = dx * dx + dz * dz <= d2;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      // GLB geometries/materials are shared with the garage's loads via the browser cache,
      // but their GPU resources are ours — walk and free them
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm?.dispose());
      });
    },
  };
}
