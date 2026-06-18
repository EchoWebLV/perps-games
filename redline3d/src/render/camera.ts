import * as THREE from "three";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (t: number) => t * t * (3 - 2 * t); // smoothstep ease

/** road speed in world units/sec from the throttle fraction (winning revs harder) */
export function roadSpeed(speedFrac: number, equity: number, live: boolean): number {
  const f = clamp(speedFrac, 0, 1);
  const base = 42 + Math.pow(f, 1.6) * 235; // ~42 .. 277 — gentler top end (was 404)
  const boost = live ? clamp(0.9 + Math.max(0, equity) * 0.06, 0.9, 1.3) : 1;
  return base * boost;
}

export interface ChaseCam {
  /** position the camera. Idle → a slow showroom orbit; driving → the chase pose. Blends between the two. */
  update(camera: THREE.PerspectiveCamera, dt: number, speed: number, carY: number, carX?: number): void;
  /** add an instantaneous camera shake (0..1+), e.g. for cinematics */
  shake(amount: number): void;
  /** true = blend to the driving chase cam (on launch); false = blend back to the idle showroom orbit */
  setDriving(driving: boolean): void;
}

// driving chase pose
const CAM_H = 9, CAM_Z = 17, LOOK_Y = 1.6, LOOK_Z = -36;
// idle showroom pose: a slow orbit around the parked car
const CAR_Z = -12, IDLE_RAD = 31, IDLE_H = 9.5, IDLE_FOV = 56, ORBIT_SPD = 0.26;

export function createChaseCam(): ChaseCam {
  let fov = IDLE_FOV, t = 0, kick = 0;
  let blend = 0;   // 0 = idle showroom orbit, 1 = driving chase
  let target = 0;  // where blend is easing toward
  let orbit = 0;   // idle orbit angle
  return {
    setDriving(driving) {
      target = driving ? 1 : 0;
    },
    update(camera, dt, speed, carY, carX = 0) {
      t += dt;
      orbit += dt * ORBIT_SPD;
      blend += (target - blend) * Math.min(1, dt * 3.4); // ~0.3s smooth transition
      const b = smooth(clamp(blend, 0, 1));

      // idle showroom pose: orbit the car, looking slightly down at it
      const ix = carX + Math.sin(orbit) * IDLE_RAD;
      const iy = carY + IDLE_H + Math.sin(t * 0.8) * 0.4;
      const iz = CAR_Z + Math.cos(orbit) * IDLE_RAD;
      const ilx = carX, ily = carY + 1.1, ilz = CAR_Z;

      // driving chase pose: behind + above the car, engine vibration (only while driving)
      const vib = ((speed / 580) * 0.03 + kick) * b;
      kick *= 0.86;
      const dx = (Math.random() - 0.5) * vib;
      const dy = carY + CAM_H + Math.sin(t * 9) * 0.05 + (Math.random() - 0.5) * vib;
      const dz = CAM_Z;
      const dlx = 0, dly = carY + LOOK_Y, dlz = LOOK_Z;
      const dFov = 60 + Math.min(18, (speed / 360) * 18); // ~60 .. 78

      // blend the two poses
      camera.position.set(ix + (dx - ix) * b, iy + (dy - iy) * b, iz + (dz - iz) * b);
      const targetFov = IDLE_FOV + (dFov - IDLE_FOV) * b;
      fov += (targetFov - fov) * 0.08;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(ilx + (dlx - ilx) * b, ily + (dly - ily) * b, ilz + (dlz - ilz) * b);
    },
    shake(amount) {
      kick = Math.max(kick, amount);
    },
  };
}
