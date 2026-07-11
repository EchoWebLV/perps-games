import * as THREE from "three";
import type { PresenceEmote, PresenceEmoteKind, RemotePresencePlayer } from "../core/presence";
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

export interface RemoteEmoteVisual extends RemoteObjectVisual {
  pulse(kind: PresenceEmoteKind): void;
  update(dt: number): void;
}

export interface RemoteCarsDeps {
  makeCar(): RemoteCarVisual;
  makeNameplate(name: string): RemoteObjectVisual;
  makeEmote?(): RemoteEmoteVisual;
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
  emoteVisual: RemoteEmoteVisual;
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

const EMOTE_GLYPHS: Record<PresenceEmoteKind, { glyph: string; color: string }> = {
  laugh: { glyph: "😂", color: "#ffd166" },
  fire: { glyph: "🔥", color: "#ff6a3d" },
  skull: { glyph: "💀", color: "#d6c7ff" },
};

function makeGlyphTexture(glyph: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, 128, 128);
  context.font = "88px 'Apple Color Emoji','Segoe UI Emoji',sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeDefaultEmoteResources() {
  const textures: Record<PresenceEmoteKind, THREE.CanvasTexture> = {
    laugh: makeGlyphTexture(EMOTE_GLYPHS.laugh.glyph),
    fire: makeGlyphTexture(EMOTE_GLYPHS.fire.glyph),
    skull: makeGlyphTexture(EMOTE_GLYPHS.skull.glyph),
  };
  return {
    make(): RemoteEmoteVisual {
      const material = new THREE.SpriteMaterial({
        map: textures.laugh,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.y = 6.8;
      sprite.visible = false;
      let age = Infinity;
      return {
        object: sprite,
        pulse(kind) {
          material.map = textures[kind];
          material.color.set(EMOTE_GLYPHS[kind].color);
          material.needsUpdate = true;
          age = 0;
          sprite.visible = true;
          sprite.position.y = 6.8;
          sprite.scale.setScalar(3);
          material.opacity = 1;
        },
        update(dt) {
          if (!sprite.visible) return;
          age += dt;
          const phase = Math.min(1, age / 0.7);
          sprite.position.y = 6.8 + phase * 2.4;
          sprite.scale.setScalar(3 + phase * 3);
          material.opacity = 1 - phase;
          if (phase >= 1) sprite.visible = false;
        },
        dispose() {
          material.dispose();
        },
      };
    },
    dispose() {
      Object.values(textures).forEach((texture) => texture.dispose());
    },
  };
}

export function createRemoteCars(resolver: RemoteCarResolver, deps: Partial<RemoteCarsDeps> = {}): RemoteCars {
  const group = new THREE.Group();
  const entries = new Map<string, RemoteEntry>();
  const makeCar = deps.makeCar ?? makeDefaultCar;
  const makeNameplate = deps.makeNameplate ?? makeDefaultNameplate;
  const defaultEmotes = deps.makeEmote ? null : makeDefaultEmoteResources();
  const makeEmote = deps.makeEmote ?? (() => defaultEmotes!.make());
  let disposed = false;
  const removeEntry = (id: string, entry: RemoteEntry) => {
    group.remove(entry.anchor);
    entry.car.dispose();
    entry.nameplate.dispose();
    entry.emoteVisual.dispose();
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
          const emoteVisual = makeEmote();
          anchor.add(car.group, nameplate.object, emoteVisual.object);
          const pose = { x: player.x, z: player.z, heading: player.heading, speed: player.speed };
          anchor.position.set(pose.x, 0, pose.z);
          anchor.rotation.y = pose.heading;
          group.add(anchor);
          entry = {
            anchor, car, nameplate, emoteVisual, name: player.name, carId: player.carId,
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
      entry.emoteVisual.pulse(event.kind);
    },
    update(dt) {
      for (const entry of entries.values()) {
        entry.current = smoothRemote(entry.current, entry.target, dt);
        entry.anchor.position.set(entry.current.x, 0, entry.current.z);
        entry.anchor.rotation.y = entry.current.heading;
        entry.car.update(dt, entry.current.speed);
        entry.emoteVisual.update(dt);
      }
    },
    clear() {
      clearEntries();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearEntries();
      defaultEmotes?.dispose();
    },
  };
}
