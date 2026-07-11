import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import type { RemotePresencePlayer } from "../core/presence";
import type { Lobby, RemoteCarState } from "./lobby";
import { createRemoteCars, type RemoteCarsDeps } from "./remote-cars";

const player = (overrides: Partial<RemotePresencePlayer> = {}): RemotePresencePlayer => ({
  id: "p1",
  name: "alice_1",
  carId: "Orion",
  x: 4,
  z: -3,
  heading: 0.25,
  speed: 12,
  ...overrides,
});

function fakeDeps() {
  const cars: Array<{
    group: THREE.Group;
    setModel: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const nameplates: Array<{ name: string; object: THREE.Group; dispose: ReturnType<typeof vi.fn> }> = [];
  const emotes: Array<{
    object: THREE.Group;
    pulse: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const deps: RemoteCarsDeps = {
    makeCar: () => {
      const car = { group: new THREE.Group(), setModel: vi.fn(), update: vi.fn(), dispose: vi.fn() };
      cars.push(car);
      return car;
    },
    makeNameplate: (name) => {
      const nameplate = { name, object: new THREE.Group(), dispose: vi.fn() };
      nameplates.push(nameplate);
      return nameplate;
    },
    makeEmote: () => {
      const emote = { object: new THREE.Group(), pulse: vi.fn(), update: vi.fn(), dispose: vi.fn() };
      emotes.push(emote);
      return emote;
    },
  };
  return { deps, cars, nameplates, emotes };
}

const resolveCar = (carId: string) => carId === "Orion"
  ? { url: "/models/orion.glb", scale: 1.2, yaw: -Math.PI / 2 }
  : carId === "Banana"
    ? { url: "/models/banana.glb", scale: undefined, yaw: Math.PI / 2 }
    : null;

function loaderHarness() {
  const loads: Array<{ url: string; succeed(gltf: GLTF): void }> = [];
  const spy = vi.spyOn(GLTFLoader.prototype, "load").mockImplementation((url, onLoad) => {
    loads.push({ url, succeed: onLoad });
    return undefined as never;
  });
  return { loads, spy };
}

function gltfFixture() {
  const texture = new THREE.Texture();
  const geometry = new THREE.BoxGeometry(2, 1, 4);
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  return {
    gltf: { scene } as unknown as GLTF,
    disposeGeometry: vi.spyOn(geometry, "dispose"),
    disposeMaterial: vi.spyOn(material, "dispose"),
    disposeTexture: vi.spyOn(texture, "dispose"),
  };
}

function nonCarVisualDeps() {
  return {
    makeNameplate: () => ({ object: new THREE.Group(), dispose: vi.fn() }),
    makeEmote: () => ({ object: new THREE.Group(), pulse: vi.fn(), update: vi.fn(), dispose: vi.fn() }),
  };
}

describe("createRemoteCars", () => {
  it("keeps identity stable while changing the equipped model", () => {
    const { deps, cars } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);

    remotes.setTargets([player()]);
    remotes.setTargets([player({ carId: "Banana" })]);

    expect(cars).toHaveLength(1);
    expect(cars[0].setModel).toHaveBeenLastCalledWith("/models/banana.glb", undefined, Math.PI / 2);
  });

  it("replaces the nameplate when a driver's name changes", () => {
    const { deps, nameplates } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);

    remotes.setTargets([player()]);
    remotes.setTargets([player({ name: "alice_2" })]);

    expect(nameplates.map(({ name }) => name)).toEqual(["alice_1", "alice_2"]);
    expect(nameplates[0].dispose).toHaveBeenCalledOnce();
  });

  it("disposes every visual resource when a driver leaves", () => {
    const { deps, cars, nameplates, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.setTargets([player({ id: "p2", name: "bob_2" })]);

    expect(remotes.group.children).toHaveLength(1);
    expect(cars[0].dispose).toHaveBeenCalledOnce();
    expect(nameplates[0].dispose).toHaveBeenCalledOnce();
    expect(emotes[0].dispose).toHaveBeenCalledOnce();
    expect(cars[1].dispose).not.toHaveBeenCalled();
  });

  it("clears every active driver", () => {
    const { deps, cars, nameplates, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.clear();

    expect(remotes.group.children).toHaveLength(0);
    expect(cars.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(nameplates.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(emotes.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("smooths toward target poses and animates the car at smoothed speed", () => {
    const { deps, cars } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player({ x: 0, z: 0, heading: 0, speed: 0 })]);
    remotes.setTargets([player({ x: 10, z: -8, heading: 1, speed: 20 })]);

    remotes.update(1 / 60);

    const anchor = remotes.group.children[0];
    expect(anchor.position.x).toBeGreaterThan(0);
    expect(anchor.position.x).toBeLessThan(10);
    expect(anchor.position.z).toBeLessThan(0);
    expect(anchor.rotation.y).toBeGreaterThan(0);
    expect(cars[0].update).toHaveBeenCalledOnce();
    expect(cars[0].update.mock.calls[0][0]).toBe(1 / 60);
    expect(cars[0].update.mock.calls[0][1]).toBeGreaterThan(0);
    expect(cars[0].update.mock.calls[0][1]).toBeLessThan(20);
  });

  it("returns to the procedural fallback without loading an unknown car id", () => {
    const { deps, cars } = fakeDeps();
    const resolver = vi.fn(resolveCar);
    const remotes = createRemoteCars(resolver, deps);
    remotes.setTargets([player()]);

    remotes.setTargets([player({ carId: "https://attacker.invalid/car.glb" })]);

    expect(resolver).toHaveBeenLastCalledWith("https://attacker.invalid/car.glb");
    expect(cars).toHaveLength(2);
    expect(cars[0].dispose).toHaveBeenCalledOnce();
    expect(cars[1].setModel).not.toHaveBeenCalled();
    expect(remotes.group.children).toHaveLength(1);
  });

  it("selects the typed visual once per fresh nonce", () => {
    const { deps, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player()]);

    remotes.emote({ id: "p1", kind: "laugh", nonce: 1 });
    remotes.emote({ id: "p1", kind: "laugh", nonce: 1 });
    remotes.emote({ id: "p1", kind: "fire", nonce: 2 });
    remotes.emote({ id: "p1", kind: "skull", nonce: 3 });

    expect(emotes[0].pulse.mock.calls).toEqual([["laugh"], ["fire"], ["skull"]]);
  });

  it("advances each driver's emote animation", () => {
    const { deps, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.update(0.125);

    expect(emotes[0].update).toHaveBeenCalledWith(0.125);
    expect(emotes[1].update).toHaveBeenCalledWith(0.125);
  });

  it("contains one emote update failure and continues updating other drivers", () => {
    const { deps, cars, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);
    emotes[0].update.mockImplementation(() => { throw new Error("animation failed"); });

    expect(() => remotes.update(0.125)).not.toThrow();
    expect(cars[1].update).toHaveBeenCalledWith(0.125, 12);
    expect(emotes[1].update).toHaveBeenCalledWith(0.125);
  });

  it("releases active resources when disposed", () => {
    const { deps, cars, nameplates, emotes } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player()]);

    remotes.dispose();
    remotes.dispose();

    expect(remotes.group.children).toHaveLength(0);
    expect(cars[0].dispose).toHaveBeenCalledOnce();
    expect(nameplates[0].dispose).toHaveBeenCalledOnce();
    expect(emotes[0].dispose).toHaveBeenCalledOnce();
  });

  it("keeps an unknown initial car procedural without starting a GLTF request", () => {
    vi.stubGlobal("window", {});
    const { loads, spy } = loaderHarness();
    const nameplate = { object: new THREE.Group(), dispose: vi.fn() };
    try {
      const remotes = createRemoteCars(() => null, {
        makeNameplate: () => nameplate,
        makeEmote: () => ({ object: new THREE.Group(), pulse: vi.fn(), update: vi.fn(), dispose: vi.fn() }),
      });

      remotes.setTargets([player({ carId: "Unknown" })]);
      expect(loads).toEqual([]);
      expect(remotes.group.children).toHaveLength(1);
      expect(() => remotes.dispose()).not.toThrow();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("returns from a known model to a procedural fallback without another request", () => {
    vi.stubGlobal("window", {});
    const { loads, spy } = loaderHarness();
    try {
      const remotes = createRemoteCars(resolveCar, nonCarVisualDeps());
      remotes.setTargets([player({ carId: "Orion" })]);
      const stale = gltfFixture();

      remotes.setTargets([player({ carId: "https://attacker.invalid/car.glb" })]);
      loads[0].succeed(stale.gltf);

      expect(loads.map(({ url }) => url)).toEqual(["/models/orion.glb"]);
      const anchor = remotes.group.children[0] as THREE.Group;
      const fallback = anchor.children[anchor.children.length - 1] as THREE.Group;
      expect(fallback.children.length).toBeGreaterThan(0);
      expect(stale.disposeGeometry).toHaveBeenCalledOnce();
      expect(stale.disposeMaterial).toHaveBeenCalledOnce();
      expect(stale.disposeTexture).toHaveBeenCalledOnce();
      remotes.dispose();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("invalidates and disposes a pending GLTF when a remote driver leaves", () => {
    vi.stubGlobal("window", {});
    const { loads, spy } = loaderHarness();
    try {
      const remotes = createRemoteCars(resolveCar, nonCarVisualDeps());
      remotes.setTargets([player({ carId: "Orion" })]);
      const late = gltfFixture();

      remotes.setTargets([]);
      loads[0].succeed(late.gltf);

      expect(remotes.group.children).toHaveLength(0);
      expect(late.disposeGeometry).toHaveBeenCalledOnce();
      expect(late.disposeMaterial).toHaveBeenCalledOnce();
      expect(late.disposeTexture).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("Lobby remote seam", () => {
  it("keeps snapshots and emotes on separate typed methods", () => {
    const snapshots: RemoteCarState[][] = [];
    const nonces: number[] = [];
    const seam: Pick<Lobby, "setRemoteCars" | "emoteRemote"> = {
      setRemoteCars: (players) => snapshots.push(players),
      emoteRemote: (event) => nonces.push(event.nonce),
    };
    const remote: RemoteCarState = player();

    seam.setRemoteCars([remote]);
    seam.emoteRemote({ id: remote.id, kind: "laugh", nonce: 7 });

    expect(snapshots[0][0]).toMatchObject({ name: "alice_1", carId: "Orion", speed: 12 });
    expect(nonces).toEqual([7]);
  });
});
