import * as THREE from "three";
import type { PresenceEmote, RemotePresencePlayer } from "../core/presence";
import { smoothRemote, type RemotePose } from "../core/remote-motion";
import { createCar } from "./car";
import { tagTexture } from "./stripcars";

export interface RemoteCarModel {
  url: string;
  scale?: number;
  yaw?: number;
}

export type RemoteCarResolver = (carId: string) => RemoteCarModel | null;

export interface RemoteCarVisual {
  group: THREE.Group;
  setModel(url: string, scale?: number, yaw?: number): void;
  update(dt: number, speed?: number): void;
  dispose(): void;
}

export interface RemoteObjectVisual {
  object: THREE.Object3D;
  dispose(): void;
}

export interface RemoteSparkVisual extends RemoteObjectVisual {
  pulse(): void;
  update(dt: number): void;
}

export interface RemoteCarsDeps {
  makeCar(): RemoteCarVisual;
  makeNameplate(name: string): RemoteObjectVisual;
  makeSpark(): RemoteSparkVisual;
}

export interface RemoteCars {
  group: THREE.Group;
  setTargets(players: RemotePresencePlayer[]): void;
  emote(event: PresenceEmote): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

interface RemoteEntry {
  anchor: THREE.Group;
  car: RemoteCarVisual;
  nameplate: RemoteObjectVisual;
  spark: RemoteSparkVisual;
  name: string;
  carId: string;
  hasResolvedModel: boolean;
  lastEmoteNonce: number;
  current: RemotePose;
  target: RemotePose;
}

function makeDefaultCar(): RemoteCarVisual {
  const car = createCar(undefined, { loadDefault: false });
  return {
    group: car.group,
    setModel: (url, scale, yaw) => car.setModel(url, scale, yaw),
    update: (dt, speed) => car.update(dt, speed),
    dispose: () => car.dispose(),
  };
}

function makeDefaultNameplate(name: string): RemoteObjectVisual {
  const texture = tagTexture(name, "#27e7ff");
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(9, 2.25, 1);
  sprite.position.y = 6.4;
  return {
    object: sprite,
    dispose() {
      material.dispose();
      texture.dispose();
    },
  };
}

function makeSparkTexture(): THREE.DataTexture {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const radius = Math.min(1, Math.hypot(dx, dy));
      const glow = 1 - radius;
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = Math.round(77 + glow * 178);
      pixels[offset + 2] = Math.round(210 + glow * 45);
      pixels[offset + 3] = Math.round(glow * glow * 255);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

function makeDefaultSpark(): RemoteSparkVisual {
  const texture = makeSparkTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.position.y = 4.5;
  sprite.visible = false;
  let age = Infinity;
  const duration = 0.55;
  return {
    object: sprite,
    pulse() {
      age = 0;
      sprite.visible = true;
      sprite.scale.setScalar(2);
      material.opacity = 1;
    },
    update(dt) {
      if (!sprite.visible) return;
      age += dt;
      const phase = Math.min(1, age / duration);
      sprite.scale.setScalar(2 + phase * 7);
      material.opacity = 1 - phase;
      if (phase >= 1) sprite.visible = false;
    },
    dispose() {
      material.dispose();
      texture.dispose();
    },
  };
}

export function createRemoteCars(resolver: RemoteCarResolver, deps: Partial<RemoteCarsDeps> = {}): RemoteCars {
  const group = new THREE.Group();
  const entries = new Map<string, RemoteEntry>();
  const makeCar = deps.makeCar ?? makeDefaultCar;
  const makeNameplate = deps.makeNameplate ?? makeDefaultNameplate;
  const makeSpark = deps.makeSpark ?? makeDefaultSpark;
  const removeEntry = (id: string, entry: RemoteEntry) => {
    group.remove(entry.anchor);
    entry.car.dispose();
    entry.nameplate.dispose();
    entry.spark.dispose();
    entry.anchor.clear();
    entries.delete(id);
  };
  const clearEntries = () => {
    for (const [id, entry] of [...entries]) removeEntry(id, entry);
  };

  return {
    group,
    setTargets(players) {
      const seen = new Set<string>();
      for (const player of players) {
        seen.add(player.id);
        let entry = entries.get(player.id);
        let created = false;
        if (!entry) {
          const anchor = new THREE.Group();
          const car = makeCar();
          const nameplate = makeNameplate(player.name);
          const spark = makeSpark();
          anchor.add(car.group, nameplate.object, spark.object);
          const pose = { x: player.x, z: player.z, heading: player.heading, speed: player.speed };
          anchor.position.set(pose.x, 0, pose.z);
          anchor.rotation.y = pose.heading;
          group.add(anchor);
          entry = {
            anchor, car, nameplate, spark, name: player.name, carId: player.carId,
            hasResolvedModel: false, lastEmoteNonce: 0, current: pose, target: pose,
          };
          entries.set(player.id, entry);
          created = true;
        }

        if (created || entry.carId !== player.carId) {
          const model = resolver(player.carId);
          if (model) {
            entry.car.setModel(model.url, model.scale, model.yaw);
            entry.hasResolvedModel = true;
          } else if (entry.hasResolvedModel) {
            entry.anchor.remove(entry.car.group);
            entry.car.dispose();
            entry.car = makeCar();
            entry.anchor.add(entry.car.group);
            entry.hasResolvedModel = false;
          }
          entry.carId = player.carId;
        }
        if (entry.name !== player.name) {
          entry.anchor.remove(entry.nameplate.object);
          entry.nameplate.dispose();
          entry.nameplate = makeNameplate(player.name);
          entry.anchor.add(entry.nameplate.object);
          entry.name = player.name;
        }
        entry.target = { x: player.x, z: player.z, heading: player.heading, speed: player.speed };
      }
      for (const [id, entry] of entries) {
        if (!seen.has(id)) removeEntry(id, entry);
      }
    },
    emote(event) {
      const entry = entries.get(event.id);
      if (!entry || event.nonce <= entry.lastEmoteNonce) return;
      entry.lastEmoteNonce = event.nonce;
      entry.spark.pulse();
    },
    update(dt) {
      for (const entry of entries.values()) {
        entry.current = smoothRemote(entry.current, entry.target, dt);
        entry.anchor.position.set(entry.current.x, 0, entry.current.z);
        entry.anchor.rotation.y = entry.current.heading;
        entry.car.update(dt, entry.current.speed);
        entry.spark.update(dt);
      }
    },
    clear() {
      clearEntries();
    },
    dispose() {
      clearEntries();
    },
  };
}
