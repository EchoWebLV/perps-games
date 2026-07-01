import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { collectWheels, pickFrontWheels, spinSign, buildWheelRig } from "./wheels";

const wheelAt = (x: number, z: number, radius = 1, extras: Record<string, unknown> = {}) => {
  const o = new THREE.Object3D();
  o.name = "wheel_0";
  o.userData.perpsWheel = { radius, axle: [1, 0, 0], up: [0, 1, 0], ...extras };
  o.position.set(x, 0.5, z);
  return o;
};
const modelWith = (...wheels: THREE.Object3D[]) => {
  const root = new THREE.Group();
  for (const w of wheels) root.add(w);
  root.updateMatrixWorld(true);
  return root;
};

describe("collectWheels", () => {
  it("finds nodes carrying userData.perpsWheel anywhere in the tree", () => {
    const root = new THREE.Group();
    const mid = new THREE.Group();
    root.add(mid);
    const w = wheelAt(0, 0, 0.3);
    mid.add(w);
    expect(collectWheels(root)).toEqual([w]);
  });
  it("ignores nodes without the tag", () => {
    const root = new THREE.Group();
    root.add(new THREE.Object3D());
    expect(collectWheels(root)).toEqual([]);
  });
});

describe("pickFrontWheels", () => {
  it("picks the min-z axle pair (car nose faces -Z)", () => {
    const ws = [wheelAt(-1, -2), wheelAt(1, -2), wheelAt(-1, 2), wheelAt(1, 2)];
    modelWith(...ws);
    expect(pickFrontWheels(ws)).toEqual([ws[0], ws[1]]);
  });
  it("six wheels: only the frontmost axle steers", () => {
    const ws = [wheelAt(-1, -2), wheelAt(1, -2), wheelAt(-1, 0), wheelAt(1, 0), wheelAt(-1, 2), wheelAt(1, 2)];
    modelWith(...ws);
    expect(pickFrontWheels(ws)).toEqual([ws[0], ws[1]]);
  });
  it("clusters axles with tolerance (slightly staggered hubs)", () => {
    const ws = [wheelAt(-1, -2.05), wheelAt(1, -1.95), wheelAt(-1, 2), wheelAt(1, 2)];
    modelWith(...ws);
    expect(pickFrontWheels(ws)).toHaveLength(2);
  });
});

describe("spinSign", () => {
  it("is -1 when the axle points at world +X (forward = negative spin)", () => {
    const w = wheelAt(0, 0);
    modelWith(w);
    expect(spinSign(w, new THREE.Vector3(1, 0, 0))).toBe(-1);
  });
  it("flips when the wheel node is yawed 180°", () => {
    const w = wheelAt(0, 0);
    const root = modelWith(w);
    root.rotation.y = Math.PI;
    root.updateMatrixWorld(true);
    expect(spinSign(w, new THREE.Vector3(1, 0, 0))).toBe(1);
  });
});

describe("buildWheelRig", () => {
  it("spins all wheels at speed/radius around the axle (negative for +X axles)", () => {
    const ws = [wheelAt(-1, -2, 0.5), wheelAt(1, -2, 0.5), wheelAt(-1, 2, 0.25), wheelAt(1, 2, 0.25)];
    const root = modelWith(...ws);
    const rig = buildWheelRig(root, 1)!;
    rig.spin(1, 1); // 1 world unit at radius 0.5 → 2 rad; at 0.25 → 4 rad
    const eu = new THREE.Euler().setFromQuaternion(ws[0].quaternion, "XYZ");
    expect(eu.x).toBeCloseTo(-2, 5);
    // -4 rad wraps past π in Euler form — compare quaternions instead
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -4);
    expect(ws[2].quaternion.angleTo(expected)).toBeCloseTo(0, 5);
  });
  it("scales model-unit radii into world units", () => {
    const ws = [wheelAt(-1, -2, 1), wheelAt(1, -2, 1), wheelAt(-1, 2, 1), wheelAt(1, 2, 1)];
    const root = modelWith(...ws);
    const rig = buildWheelRig(root, 2)!; // world radius = 2
    rig.spin(1, 1);
    const eu = new THREE.Euler().setFromQuaternion(ws[0].quaternion, "XYZ");
    expect(eu.x).toBeCloseTo(-0.5, 5);
  });
  it("steers only the front axle", () => {
    const ws = [wheelAt(-1, -2), wheelAt(1, -2), wheelAt(-1, 2), wheelAt(1, 2)];
    const root = modelWith(...ws);
    const rig = buildWheelRig(root, 1)!;
    rig.steer(0.3);
    rig.spin(0, 0);
    const front = new THREE.Euler().setFromQuaternion(ws[0].quaternion, "YXZ");
    const rear = new THREE.Euler().setFromQuaternion(ws[2].quaternion, "YXZ");
    expect(front.y).toBeCloseTo(0.3, 5);
    expect(rear.y).toBeCloseTo(0, 5);
  });
  it("two rollers (flintstone): nothing steers", () => {
    const ws = [wheelAt(0, -2), wheelAt(0, 2)];
    const root = modelWith(...ws);
    const rig = buildWheelRig(root, 1)!;
    rig.steer(0.5);
    rig.spin(0, 0);
    const eu = new THREE.Euler().setFromQuaternion(ws[0].quaternion, "YXZ");
    expect(eu.y).toBeCloseTo(0, 5);
  });
  it("preserves a tagged joint's rest rotation (delorean path)", () => {
    const w = wheelAt(-1, -2);
    w.rotation.y = Math.PI / 2; // rest pose from the GLB
    // axle/up expressed in node-local space by the rig script
    w.userData.perpsWheel = { radius: 1, axle: [0, 0, -1], up: [0, 1, 0] };
    const ws = [w, wheelAt(1, -2), wheelAt(-1, 2), wheelAt(1, 2)];
    const root = modelWith(...ws);
    const rig = buildWheelRig(root, 1)!;
    rig.spin(0, 0); // no spin, no steer — pose must be exactly the rest pose
    const eu = new THREE.Euler().setFromQuaternion(w.quaternion, "YXZ");
    expect(eu.y).toBeCloseTo(Math.PI / 2, 5);
  });
  it("returns null when the model has no tagged wheels", () => {
    expect(buildWheelRig(modelWith(), 1)).toBeNull();
  });
});
