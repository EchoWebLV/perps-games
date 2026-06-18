import * as THREE from "three";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** road speed in world units/sec from the throttle fraction (winning revs harder) */
export function roadSpeed(speedFrac: number, equity: number, live: boolean): number {
  const f = clamp(speedFrac, 0, 1);
  const base = 44 + Math.pow(f, 1.5) * 360; // ~44 .. 404
  const boost = live ? clamp(0.9 + Math.max(0, equity) * 0.09, 0.9, 1.7) : 1;
  return base * boost;
}

export interface ChaseCam {
  /** position the camera behind the car at height carY so the car stays framed and the road flows under it */
  update(camera: THREE.PerspectiveCamera, dt: number, speed: number, carY: number): void;
  /** add an instantaneous camera shake (0..1+), e.g. for cinematics */
  shake(amount: number): void;
}

const CAM_H = 9, CAM_Z = 17, LOOK_Y = 1.6, LOOK_Z = -36;

export function createChaseCam(): ChaseCam {
  let fov = 70, t = 0, kick = 0;
  return {
    update(camera, dt, speed, carY) {
      t += dt;
      // FOV widens with speed for a visceral rush
      const targetFov = 62 + Math.min(34, (speed / 580) * 34);
      fov += (targetFov - fov) * 0.08;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      // engine vibration grows with speed; cinematic kick decays on top
      const vib = (speed / 580) * 0.05 + kick;
      kick *= 0.86;
      camera.position.set(
        (Math.random() - 0.5) * vib,
        carY + CAM_H + Math.sin(t * 9) * 0.05 + (Math.random() - 0.5) * vib,
        CAM_Z
      );
      camera.lookAt(0, carY + LOOK_Y, LOOK_Z);
    },
    shake(amount) {
      kick = Math.max(kick, amount);
    },
  };
}
