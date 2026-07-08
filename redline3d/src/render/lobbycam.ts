import * as THREE from "three";

export interface LobbyCam {
  /**
   * follow the free-roam car: locked directly behind it, every frame.
   * `y` = ground height under the car — the highway passes road elevation; the lobby is flat.
   */
  update(camera: THREE.PerspectiveCamera, dt: number, x: number, z: number, heading: number, y?: number): void;
  reset(): void;
}

// pulled back per user feel: 17/8.5 framed the car too tight, especially at highway speed
const BACK = 26, HEIGHT = 12, LOOK_AHEAD = 18, LOOK_Y = 1.6, FOV = 64;

export function createLobbyCam(): LobbyCam {
  return {
    reset() {},
    update(camera, _dt, x, z, heading, y = 0) {
      // RIGID chase: camera is always exactly behind the car's current heading.
      // No easing, no lag — "forward" is locked to up-screen.
      const fx = Math.sin(heading), fz = -Math.cos(heading);
      // Portrait pullback: a narrow viewport loses horizontal FOV, cropping the strip's
      // parked cars and storefronts out of frame — back off (and rise) as aspect shrinks
      // below ~4:3. Zero effect on landscape.
      const extra = Math.max(0, 1.35 - camera.aspect) * 24;
      camera.position.set(x - fx * (BACK + extra), y + HEIGHT + extra * 0.25, z - fz * (BACK + extra));
      if (camera.fov !== FOV) { camera.fov = FOV; camera.updateProjectionMatrix(); }
      camera.lookAt(x + fx * LOOK_AHEAD, y + LOOK_Y, z + fz * LOOK_AHEAD);
    },
  };
}
