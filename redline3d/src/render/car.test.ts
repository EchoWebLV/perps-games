import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCar } from "./car";

interface PendingLoad {
  url: string;
  succeed(gltf: GLTF): void;
  fail(error: unknown): void;
}

const pending: PendingLoad[] = [];

function modelFixture() {
  const texture = new THREE.Texture();
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  const disposeGeometry = vi.spyOn(geometry, "dispose");
  const disposeMaterial = vi.spyOn(material, "dispose");
  const disposeTexture = vi.spyOn(texture, "dispose");
  const gltf = { scene } as unknown as GLTF;
  return { gltf, scene, disposeGeometry, disposeMaterial, disposeTexture };
}

beforeEach(() => {
  pending.length = 0;
  vi.stubGlobal("window", {});
  vi.spyOn(GLTFLoader.prototype, "load").mockImplementation((url, onLoad, _onProgress, onError) => {
    pending.push({
      url,
      succeed: onLoad,
      fail: (error) => onError?.(error),
    });
    return undefined as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createCar GLTF lifecycle", () => {
  it("keeps the player car default model request backward compatible", () => {
    createCar();

    expect(pending.map(({ url }) => url)).toEqual(["/models/delorean.glb"]);
  });

  it("can keep the procedural fallback without requesting the default model", () => {
    const car = createCar(undefined, { loadDefault: false });

    expect(pending).toHaveLength(0);
    expect(car.group.children.length).toBeGreaterThan(0);
  });

  it("disposes a model callback that arrives after the car was disposed", () => {
    const car = createCar(undefined, { loadDefault: false });
    car.setModel("/models/orion.glb");
    const model = modelFixture();

    car.dispose();
    pending[0].succeed(model.gltf);

    expect(car.group.children).toHaveLength(0);
    expect(model.scene.parent).toBeNull();
    expect(model.disposeGeometry).toHaveBeenCalledOnce();
    expect(model.disposeMaterial).toHaveBeenCalledOnce();
    expect(model.disposeTexture).toHaveBeenCalledOnce();
  });

  it("disposes the previous GLTF resources when a new model replaces it", () => {
    const car = createCar(undefined, { loadDefault: false });
    car.setModel("/models/orion.glb");
    const first = modelFixture();
    pending[0].succeed(first.gltf);
    car.setModel("/models/banana.glb");
    const second = modelFixture();

    pending[1].succeed(second.gltf);

    expect(first.scene.parent).toBeNull();
    expect(first.disposeGeometry).toHaveBeenCalledOnce();
    expect(first.disposeMaterial).toHaveBeenCalledOnce();
    expect(first.disposeTexture).toHaveBeenCalledOnce();
    expect(second.scene.parent).toBe(car.group);
    expect(second.disposeGeometry).not.toHaveBeenCalled();
  });

  it("disposes a stale callback after a newer request supersedes it", () => {
    const car = createCar(undefined, { loadDefault: false });
    car.setModel("/models/orion.glb");
    car.setModel("/models/banana.glb");
    const stale = modelFixture();
    const latest = modelFixture();

    pending[0].succeed(stale.gltf);
    pending[1].succeed(latest.gltf);

    expect(stale.scene.parent).toBeNull();
    expect(stale.disposeGeometry).toHaveBeenCalledOnce();
    expect(stale.disposeMaterial).toHaveBeenCalledOnce();
    expect(stale.disposeTexture).toHaveBeenCalledOnce();
    expect(latest.scene.parent).toBe(car.group);
  });

  it("reports the first successful current model as loaded once", () => {
    const settled = vi.fn();
    createCar(settled);
    pending[0].succeed(modelFixture().gltf);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("loaded");
  });

  it("reports a current first-model failure once", () => {
    const settled = vi.fn();
    createCar(settled);
    pending[0].fail(new Error("cold load failed"));
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("failed");
  });

  it("does not settle from a stale model callback", () => {
    const settled = vi.fn();
    const car = createCar(settled, { loadDefault: false });
    car.setModel("/models/old.glb");
    car.setModel("/models/new.glb");
    pending[0].succeed(modelFixture().gltf);
    expect(settled).not.toHaveBeenCalled();
    pending[1].succeed(modelFixture().gltf);
    expect(settled).toHaveBeenCalledWith("loaded");
  });

  it("uses a neutral rough fallback body before a GLB arrives", () => {
    const car = createCar(undefined, { loadDefault: false });
    const placeholder = car.group.children[0] as THREE.Group;
    const body = placeholder.children[0] as THREE.Mesh;
    const material = body.material as THREE.MeshStandardMaterial;
    expect(material.color.getHexString()).toBe("b5bbc4");
    expect(material.metalness).toBe(0.4);
    expect(material.roughness).toBe(0.76);
    expect(material.emissive.getHexString()).toBe("59616d");
    expect(material.emissiveIntensity).toBe(0.32);
  });
});
