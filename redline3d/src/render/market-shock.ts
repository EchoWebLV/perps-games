import * as THREE from "three";
import type { MarketDirection } from "../core/market-pulse";

const SHOCK_DURATION = 0.75;
const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

export interface MarketShockCoreInput {
  active: boolean;
  shockId: number;
  strength: number;
  direction: MarketDirection;
  reducedMotion: boolean;
}

export interface MarketShockCoreFrame {
  active: boolean;
  triggered: boolean;
  progress: number;
  flash: number;
  cameraImpulse: number;
  direction: MarketDirection;
}

export interface MarketShockCore {
  update(input: MarketShockCoreInput, dt: number): MarketShockCoreFrame;
  reset(shockId?: number): void;
}

export function createMarketShockCore(): MarketShockCore {
  let seenId = 0;
  let age = SHOCK_DURATION;
  let strength = 0;
  let direction: MarketDirection = 0;

  const idle = (): MarketShockCoreFrame => ({
    active: false,
    triggered: false,
    progress: 1,
    flash: 0,
    cameraImpulse: 0,
    direction,
  });

  return {
    reset(shockId = 0) {
      seenId = shockId;
      age = SHOCK_DURATION;
      strength = 0;
      direction = 0;
    },

    update(input, rawDt) {
      const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0, 0, 0.1);
      if (!input.active) {
        seenId = input.shockId;
        age = SHOCK_DURATION;
        strength = 0;
        direction = 0;
        return idle();
      }

      let triggered = false;
      let cameraImpulse = 0;
      if (input.shockId > seenId) {
        seenId = input.shockId;
        age = 0;
        strength = clamp(input.strength);
        direction = input.direction < 0 ? -1 : input.direction > 0 ? 1 : 0;
        triggered = true;
        if (!input.reducedMotion) cameraImpulse = 0.25 + strength * 0.55;
      }

      if (age >= SHOCK_DURATION) return idle();
      age = Math.min(SHOCK_DURATION, age + dt);
      const progress = age / SHOCK_DURATION;
      return {
        active: progress < 1,
        triggered,
        progress,
        flash: strength * (1 - progress) * (1 - progress),
        cameraImpulse,
        direction,
      };
    },
  };
}

export function marketShockColor(direction: MarketDirection): string {
  return direction < 0 ? "#ff326f" : "#2effc5";
}

export function marketShockLightBoost(amount: number): number {
  return 1 + clamp(amount) * 1.8;
}

export interface MarketShockOptions {
  detail: "full" | "reduced";
  reducedMotion: boolean;
  surfaceY(worldZ: number): number;
  onWorldPulse(amount: number, direction: MarketDirection): void;
  onCameraShake(amount: number): void;
}

export interface MarketShockUpdate {
  active: boolean;
  shockId: number;
  strength: number;
  direction: MarketDirection;
}

export interface MarketShock {
  group: THREE.Group;
  update(input: MarketShockUpdate, dt: number): MarketShockCoreFrame;
  reset(shockId?: number): void;
}

export function createMarketShock(options: MarketShockOptions): MarketShock {
  const core = createMarketShockCore();
  const group = new THREE.Group();
  const geometry = new THREE.RingGeometry(0.82, 1, 64);
  const makeRing = (opacity: number) => {
    const material = new THREE.MeshBasicMaterial({
      color: marketShockColor(1),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
    return { mesh, material };
  };
  const rings = [makeRing(0.9)];
  if (options.detail === "full") rings.push(makeRing(0.42));
  group.visible = false;

  return {
    group,

    reset(shockId = 0) {
      core.reset(shockId);
      group.visible = false;
      options.onWorldPulse(0, 0);
    },

    update(input, dt) {
      const frame = core.update({ ...input, reducedMotion: options.reducedMotion }, dt);
      if (frame.cameraImpulse > 0) options.onCameraShake(frame.cameraImpulse);
      options.onWorldPulse(frame.flash, frame.direction);
      group.visible = frame.active;
      if (!frame.active) return frame;

      const travel = frame.progress * frame.progress * (3 - 2 * frame.progress);
      const z = -150 + 138 * travel;
      const scale = 10 + 40 * frame.progress;
      const color = marketShockColor(frame.direction);
      rings.forEach((ring, index) => {
        ring.mesh.position.set(0, options.surfaceY(z) + 0.16 + index * 0.03, z);
        ring.mesh.scale.setScalar(scale * (1 + index * 0.12));
        ring.material.color.set(color);
        ring.material.opacity = frame.flash * (index === 0 ? 0.9 : 0.42);
      });
      return frame;
    },
  };
}
