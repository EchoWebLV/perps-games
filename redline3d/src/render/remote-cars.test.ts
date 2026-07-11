import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
  const sparks: Array<{
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
    makeSpark: () => {
      const spark = { object: new THREE.Group(), pulse: vi.fn(), update: vi.fn(), dispose: vi.fn() };
      sparks.push(spark);
      return spark;
    },
  };
  return { deps, cars, nameplates, sparks };
}

const resolveCar = (carId: string) => carId === "Orion"
  ? { url: "/models/orion.glb", scale: 1.2, yaw: -Math.PI / 2 }
  : carId === "Banana"
    ? { url: "/models/banana.glb", scale: undefined, yaw: Math.PI / 2 }
    : null;

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
    const { deps, cars, nameplates, sparks } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.setTargets([player({ id: "p2", name: "bob_2" })]);

    expect(remotes.group.children).toHaveLength(1);
    expect(cars[0].dispose).toHaveBeenCalledOnce();
    expect(nameplates[0].dispose).toHaveBeenCalledOnce();
    expect(sparks[0].dispose).toHaveBeenCalledOnce();
    expect(cars[1].dispose).not.toHaveBeenCalled();
  });

  it("clears every active driver", () => {
    const { deps, cars, nameplates, sparks } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.clear();

    expect(remotes.group.children).toHaveLength(0);
    expect(cars.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(nameplates.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
    expect(sparks.every(({ dispose }) => dispose.mock.calls.length === 1)).toBe(true);
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

  it("pulses once for each new spark nonce", () => {
    const { deps, sparks } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.emote({ id: "p1", kind: "spark", nonce: 1 });
    remotes.emote({ id: "p1", kind: "spark", nonce: 1 });
    remotes.emote({ id: "p1", kind: "spark", nonce: 2 });
    remotes.emote({ id: "p2", kind: "spark", nonce: 1 });
    remotes.emote({ id: "gone", kind: "spark", nonce: 1 });

    expect(sparks[0].pulse).toHaveBeenCalledTimes(2);
    expect(sparks[1].pulse).toHaveBeenCalledOnce();
  });

  it("advances each driver's spark animation", () => {
    const { deps, sparks } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player(), player({ id: "p2", name: "bob_2" })]);

    remotes.update(0.125);

    expect(sparks[0].update).toHaveBeenCalledWith(0.125);
    expect(sparks[1].update).toHaveBeenCalledWith(0.125);
  });

  it("releases active resources when disposed", () => {
    const { deps, cars, nameplates, sparks } = fakeDeps();
    const remotes = createRemoteCars(resolveCar, deps);
    remotes.setTargets([player()]);

    remotes.dispose();
    remotes.dispose();

    expect(remotes.group.children).toHaveLength(0);
    expect(cars[0].dispose).toHaveBeenCalledOnce();
    expect(nameplates[0].dispose).toHaveBeenCalledOnce();
    expect(sparks[0].dispose).toHaveBeenCalledOnce();
  });

  it("uses the createCar adapter when makeCar is omitted", () => {
    vi.stubGlobal("window", {});
    const load = vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(() => undefined as never);
    const nameplate = { object: new THREE.Group(), dispose: vi.fn() };
    try {
      const remotes = createRemoteCars(() => null, {
        makeNameplate: () => nameplate,
      });

      remotes.setTargets([player({ carId: "Unknown" })]);
      expect(remotes.group.children).toHaveLength(1);
      expect(() => remotes.dispose()).not.toThrow();
    } finally {
      load.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("Lobby remote seam", () => {
  it("keeps snapshots and spark emotes on separate typed methods", () => {
    const snapshots: RemoteCarState[][] = [];
    const nonces: number[] = [];
    const seam: Pick<Lobby, "setRemoteCars" | "emoteRemote"> = {
      setRemoteCars: (players) => snapshots.push(players),
      emoteRemote: (event) => nonces.push(event.nonce),
    };
    const remote: RemoteCarState = player();

    seam.setRemoteCars([remote]);
    seam.emoteRemote({ id: remote.id, kind: "spark", nonce: 7 });

    expect(snapshots[0][0]).toMatchObject({ name: "alice_1", carId: "Orion", speed: 12 });
    expect(nonces).toEqual([7]);
  });
});
