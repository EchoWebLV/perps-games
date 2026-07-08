import * as THREE from "three";

/** one flame patch on the road, exposed by the core so the view can place + fade it */
export interface Flame { x: number; z: number; age: number; life: number; }

export const TRAIL_GAP = 2.6;    // road distance between flame pairs — dashed BTTF stripes, not a solid smear
export const TRAIL_TRACK = 2.2;  // lateral spacing = the car's rear wheel track
export const TRAIL_LIFE = 1.3;   // seconds a flame burns before it's gone
export const TRAIL_MAX = 64;     // flame pool cap (oldest recycled first)

/**
 * Pure spawn/scroll/expiry logic for the DeLorean's flux fire traces — no three.js,
 * unit-testable. While `active`, lays a PAIR of flames (one per rear wheel) every
 * TRAIL_GAP units of road travel; flames scroll toward the camera with the road
 * (z += speed·dt, the pickups convention) and burn out after TRAIL_LIFE seconds.
 */
export function createFireTrailCore() {
  const flames: Flame[] = [];
  let dist = 0; // road travelled since the last pair
  return {
    update(dt: number, speed: number, active: boolean, carX: number, carZ: number): Flame[] {
      // scroll + age what's burning
      for (const f of flames) { f.z += speed * dt; f.age += dt; }
      for (let i = flames.length - 1; i >= 0; i--) if (flames[i].age >= flames[i].life) flames.splice(i, 1);

      if (active) {
        dist += speed * dt;
        while (dist >= TRAIL_GAP) {
          dist -= TRAIL_GAP;
          // spawn the pair back-dated along the gap so a big frame still spaces evenly
          const behind = dist; // how far the road has moved since this pair's spot
          for (const side of [-1, 1]) flames.push({ x: carX + (side * TRAIL_TRACK) / 2, z: carZ + behind, age: 0, life: TRAIL_LIFE });
          while (flames.length > TRAIL_MAX) flames.shift(); // recycle oldest
        }
      } else {
        dist = 0; // freeze over → next window starts its stripes fresh at the car
      }
      return flames;
    },
  };
}

export interface FireTrail {
  group: THREE.Group;
  /** advance the trail; call every frame with the road speed + the car's lane x / fixed z */
  update(dt: number, speed: number, active: boolean, carX: number, carZ: number, surfaceY: (z: number) => number): void;
}

/** radial fire sprite — orange core → red rim → transparent (canvas, no asset needed) */
function flameTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,240,180,1)");
  grad.addColorStop(0.35, "rgba(255,150,40,0.9)");
  grad.addColorStop(0.7, "rgba(255,60,10,0.45)");
  grad.addColorStop(1, "rgba(255,30,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * DeLorean flux fire traces: while the Flux Brake freeze is active the car leaves two
 * dashed lines of burning patches on the road (the time-jump look). Additive-blended
 * quads lying on the asphalt; each flame flares up, stretches back and fades out.
 */
export function createFireTrail(): FireTrail {
  const core = createFireTrailCore();
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(1.5, 3.2); // longer than wide — a scorch streak, not a dot
  const tex = flameTexture();
  const pool: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  for (let i = 0; i < TRAIL_MAX; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, // additive glow must not punch holes in the road/fog
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2; // lie flat on the asphalt
    m.visible = false;
    group.add(m);
    pool.push(m);
  }

  return {
    group,
    update(dt, speed, active, carX, carZ, surfaceY) {
      const flames = core.update(dt, speed, active, carX, carZ);
      for (let i = 0; i < pool.length; i++) {
        const m = pool[i], f = flames[i];
        if (!f) { m.visible = false; continue; }
        const t = f.age / f.life; // 0 fresh → 1 out
        m.visible = true;
        m.position.set(f.x, surfaceY(f.z) + 0.06, f.z); // hug the hills like the coins do
        const flick = 1 + 0.12 * Math.sin(f.age * 40 + f.x * 7); // fast per-flame shimmer
        m.scale.set((1 + 0.5 * t) * flick, 1 + 1.6 * t, 1); // spreads + stretches back as it burns
        m.material.opacity = (1 - t) * (1 - t) * 0.95; // hot start, quick falloff
      }
    },
  };
}
