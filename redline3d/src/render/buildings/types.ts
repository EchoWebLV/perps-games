import type * as THREE from "three";

/** Registers a GPU-backed resource (geometry/material) for disposal when the lobby tears down.
 *  Builders MUST wrap every `new THREE.*Geometry`/`new THREE.*Material` in this. */
export type Track = <T extends { dispose(): void }>(o: T) => T;

/**
 * A themed lobby building, built in LOCAL space:
 *  - centered on the origin (x=0, z=0), sitting on the ground (y=0, grows +y)
 *  - its FRONT / entrance faces +Z (the lobby rotates the whole group so +Z points at the plaza)
 */
export interface BuiltBuilding {
  group: THREE.Group;
  /** local Y at which the neon name sign should float (a little above the roofline) */
  signY: number;
  /** local +Z of the front face — the sign and entrance lamp sit at this depth */
  frontZ: number;
  /** optional per-frame pulse for animated greebles; t is seconds since the lobby was created */
  animate?: (t: number) => void;
}
