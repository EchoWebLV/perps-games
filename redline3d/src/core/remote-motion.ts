export interface RemotePose {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export const REMOTE_SNAP_DISTANCE = 30;

const TAU = Math.PI * 2;

function normalizeAngle(angle: number): number {
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function shortestAngleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

export function smoothRemote(current: RemotePose, target: RemotePose, dt: number): RemotePose {
  if (Math.hypot(target.x - current.x, target.z - current.z) > REMOTE_SNAP_DISTANCE) {
    return { ...target, heading: normalizeAngle(target.heading) };
  }

  const alpha = 1 - Math.exp(-12 * dt);
  return {
    x: current.x + (target.x - current.x) * alpha,
    z: current.z + (target.z - current.z) * alpha,
    heading: normalizeAngle(current.heading + shortestAngleDelta(current.heading, target.heading) * alpha),
    speed: current.speed + (target.speed - current.speed) * alpha,
  };
}
