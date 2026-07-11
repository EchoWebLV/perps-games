import * as THREE from "three";
import type { PresenceEmoteKind } from "../core/presence";

export interface EmoteVisual {
  object: THREE.Object3D;
  pulse(kind: PresenceEmoteKind): void;
  update(dt: number): void;
  dispose(): void;
}

export interface EmoteVisualResources {
  make(): EmoteVisual;
  dispose(): void;
}

export type EmoteTextureFactory = (glyph: string) => THREE.Texture;

export const EMOTE_GLYPHS: Record<PresenceEmoteKind, { glyph: string; color: string }> = {
  laugh: { glyph: "😂", color: "#ffd166" },
  fire: { glyph: "🔥", color: "#ff6a3d" },
  skull: { glyph: "💀", color: "#d6c7ff" },
};

const START_Y = 6.8;
const DURATION_SECONDS = 0.7;

function makeGlyphTexture(glyph: string): THREE.Texture {
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

export function createEmoteVisualResources(
  makeTexture: EmoteTextureFactory = makeGlyphTexture,
): EmoteVisualResources {
  const textures: Record<PresenceEmoteKind, THREE.Texture> = {
    laugh: makeTexture(EMOTE_GLYPHS.laugh.glyph),
    fire: makeTexture(EMOTE_GLYPHS.fire.glyph),
    skull: makeTexture(EMOTE_GLYPHS.skull.glyph),
  };

  return {
    make() {
      const material = new THREE.SpriteMaterial({
        map: textures.laugh,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.y = START_Y;
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
          sprite.position.y = START_Y;
          sprite.scale.setScalar(3);
          material.opacity = 1;
        },
        update(dt) {
          if (!sprite.visible) return;
          age += dt;
          const phase = Math.min(1, age / DURATION_SECONDS);
          sprite.position.y = START_Y + phase * 2.4;
          sprite.scale.setScalar(3 + phase * 3);
          material.opacity = 1 - phase;
          if (phase >= 1) sprite.visible = false;
        },
        dispose() {
          material.dispose();
        },
      } satisfies EmoteVisual;
    },
    dispose() {
      Object.values(textures).forEach((texture) => texture.dispose());
    },
  };
}

export function updateEmoteVisual(visual: EmoteVisual, dt: number): void {
  try {
    visual.update(dt);
  } catch {
    // Emotes are optional visuals and cannot interrupt the driving loop.
  }
}
