import * as THREE from "three";

export interface LobbyCam {
  /**
   * follow the free-roam car: locked directly behind it, every frame.
   * `y` = ground height under the car — the highway passes road elevation; the lobby is flat.
   */
  update(camera: THREE.PerspectiveCamera, dt: number, x: number, z: number, heading: number, y?: number): void;
  reset(): void;
}

const BACK = 17, HEIGHT = 8.5, LOOK_AHEAD = 12, LOOK_Y = 1.6, FOV = 64;

export function createLobbyCam(): LobbyCam {
  return {
    reset() {},
    update(camera, _dt, x, z, heading, y = 0) {
      // RIGID chase: camera is always exactly behind the car's current heading.
      // No easing, no lag — "forward" is locked to up-screen.
      const fx = Math.sin(heading), fz = -Math.cos(heading);
      camera.position.set(x - fx * BACK, y + HEIGHT, z - fz * BACK);
      if (camera.fov !== FOV) { camera.fov = FOV; camera.updateProjectionMatrix(); }
      camera.lookAt(x + fx * LOOK_AHEAD, y + LOOK_Y, z + fz * LOOK_AHEAD);
    },
  };
}
