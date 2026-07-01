import * as THREE from "three";

/**
 * Runtime wheel rig. The offline rig script (scripts/rig-wheels.mjs) rewrote
 * every car GLB so each wheel is a node/joint with
 *   userData.perpsWheel = { radius, axle:[x,y,z], up:[x,y,z] }
 * (radius in model units; axle/up are node-LOCAL directions). Cut wheels get
 * pivot at the hub with identity axes; tagged joints (delorean) and named
 * nodes (flintstone rollers) keep their rest pose — so every frame we compose
 *   pose = rest × steer(up) × spin(axle)
 * The front axle is picked geometrically: the car nose faces -Z in car space.
 */
export interface WheelRig {
  /** advance wheel roll; speed in world units/sec (road speed / lobby drive speed) */
  spin(dt: number, speed: number): void;
  /** steer the front axle, in radians (already clamped by the caller) */
  steer(angle: number): void;
}

interface WheelTag { radius: number; axle: number[]; up: number[] }

export function collectWheels(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    const t = o.userData?.perpsWheel as WheelTag | undefined;
    if (t && t.radius > 0) out.push(o);
  });
  return out;
}

/** front axle = the wheels sharing the smallest z in car space (nose faces -Z);
 *  matrixWorld must be current (model.updateMatrixWorld(true) before calling) */
export function pickFrontWheels(wheels: THREE.Object3D[]): THREE.Object3D[] {
  const zs = wheels.map((w) => new THREE.Vector3().setFromMatrixPosition(w.matrixWorld).z);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const tol = Math.max((maxZ - minZ) * 0.25, 1e-6);
  return wheels.filter((_, i) => zs[i] - minZ < tol);
}

/** sign so positive forward speed rolls the wheel forward: an axle pointing at
 *  car +X must spin negatively (right-hand rule, car nose faces -Z) */
export function spinSign(wheel: THREE.Object3D, axleLocal: THREE.Vector3): -1 | 1 {
  const world = axleLocal.clone().transformDirection(wheel.matrixWorld);
  return world.x >= 0 ? -1 : 1;
}

export function buildWheelRig(model: THREE.Object3D, worldScale: number): WheelRig | null {
  model.updateMatrixWorld(true);
  const wheels = collectWheels(model);
  if (!wheels.length) return null;
  // rollers span the car (flintstone's 2) — nothing steers on those rigs
  const fronts = new Set(wheels.length >= 3 ? pickFrontWheels(wheels) : []);
  const per = wheels.map((o) => {
    const t = o.userData.perpsWheel as WheelTag;
    const axle = new THREE.Vector3().fromArray(t.axle).normalize();
    return {
      o,
      radius: Math.max(t.radius * worldScale, 1e-6),
      axle,
      up: new THREE.Vector3().fromArray(t.up).normalize(),
      rest: o.quaternion.clone(),
      sign: spinSign(o, axle),
      front: fronts.has(o),
    };
  });
  let travel = 0;      // accumulated world-units of road under the wheels
  let steerAngle = 0;
  if (typeof window !== "undefined" && import.meta.env?.DEV) (window as any).__wheels = per; // preview probe
  const qSteer = new THREE.Quaternion();
  const qSpin = new THREE.Quaternion();
  const apply = () => {
    for (const p of per) {
      qSpin.setFromAxisAngle(p.axle, (p.sign * travel) / p.radius);
      if (p.front && steerAngle !== 0) {
        qSteer.setFromAxisAngle(p.up, steerAngle);
        p.o.quaternion.copy(p.rest).multiply(qSteer).multiply(qSpin);
      } else {
        p.o.quaternion.copy(p.rest).multiply(qSpin);
      }
    }
  };
  return {
    spin(dt, speed) {
      travel += dt * speed;
      apply();
    },
    steer(angle) {
      steerAngle = angle;
    },
  };
}
