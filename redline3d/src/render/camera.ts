import * as THREE from "three";
import { levFrac } from "../core/leverage";

export interface ChaseCam {
  /** call each frame; returns the road speed (world units/sec) to scroll the world */
  update(camera: THREE.PerspectiveCamera, dt: number, lev: number, equity: number, live: boolean): number;
  /** add an instantaneous camera shake (0..1+), e.g. for cinematics */
  shake(amount: number): void;
}

const BASE_Y = 7.5;

export function createChaseCam(): ChaseCam {
  let fov = 70;
  let t = 0;
  let kick = 0;
  return {
    update(camera, dt, lev, equity, live) {
      t += dt;
      // road speed (units/sec): slow at min lev, very fast near the redline; winning revs harder
      const base = 44 + Math.pow(levFrac(lev), 1.5) * 360; // ~44 .. 404
      const boost = live ? Math.max(0.9, Math.min(1.7, 0.9 + Math.max(0, equity) * 0.09)) : 1;
      const speed = base * boost;

      // FOV widens with speed for a visceral rush
      const targetFov = 62 + Math.min(34, (speed / 580) * 34);
      fov += (targetFov - fov) * 0.08;
      camera.fov = fov;
      camera.updateProjectionMatrix();

      // engine vibration grows with speed; cinematic kick decays on top
      const vib = (speed / 580) * 0.09 + kick;
      camera.position.x = (Math.random() - 0.5) * vib;
      camera.position.y = BASE_Y + Math.sin(t * 9) * 0.05 + (Math.random() - 0.5) * vib;
      kick *= 0.88;

      return speed;
    },
    shake(amount) {
      kick = Math.max(kick, amount);
    },
  };
}
