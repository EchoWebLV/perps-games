import * as THREE from "three";
import { levFrac } from "../core/leverage";

export interface ChaseCam {
  /** call each frame with current leverage + equity; returns the road speed to scroll */
  update(camera: THREE.PerspectiveCamera, dt: number, lev: number, equity: number, live: boolean): number;
}

export function createChaseCam(): ChaseCam {
  let fov = 70;
  return {
    update(camera, _dt, lev, equity, live) {
      // road speed: slow at min lev, fast (not warp) near redline; winning revs faster
      const base = 24 + Math.pow(levFrac(lev), 1.5) * 600;
      const boost = live ? Math.max(0.9, Math.min(1.4, 0.9 + Math.max(0, equity) * 0.06)) : 1;
      const speed = base * boost;
      // FOV widens with speed for a visceral rush
      const targetFov = 66 + Math.min(26, (speed / 640) * 26);
      fov += (targetFov - fov) * 0.08;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      return speed * 0.05; // scale into world units/sec for world.update
    },
  };
}
