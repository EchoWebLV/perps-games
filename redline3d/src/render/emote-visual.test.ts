import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { createEmoteVisualResources, EMOTE_GLYPHS, updateEmoteVisual } from "./emote-visual";

describe("createEmoteVisualResources", () => {
  it("creates ordered glyph textures and selects the requested kind", () => {
    const glyphs: string[] = [];
    const textures: THREE.Texture[] = [];
    const resources = createEmoteVisualResources((glyph) => {
      glyphs.push(glyph);
      const texture = new THREE.Texture();
      textures.push(texture);
      return texture;
    });
    const visual = resources.make();
    const sprite = visual.object as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;

    expect(glyphs).toEqual(["😂", "🔥", "💀"]);
    visual.pulse("fire");
    expect(material.map).toBe(textures[1]);
    expect(material.color.getHexString()).toBe(EMOTE_GLYPHS.fire.color.slice(1));
    expect(sprite.visible).toBe(true);
    expect(sprite.position.y).toBe(6.8);
    expect(sprite.scale.x).toBe(3);
  });

  it("restarts a pulse and hides it after the bounded animation", () => {
    const resources = createEmoteVisualResources(() => new THREE.Texture());
    const visual = resources.make();
    const sprite = visual.object as THREE.Sprite;
    const material = sprite.material as THREE.SpriteMaterial;

    visual.pulse("laugh");
    visual.update(0.35);
    expect(sprite.position.y).toBeCloseTo(8);
    expect(material.opacity).toBeCloseTo(0.5);
    visual.pulse("skull");
    expect(sprite.position.y).toBe(6.8);
    expect(material.opacity).toBe(1);
    visual.update(0.7);
    expect(sprite.visible).toBe(false);
  });

  it("disposes the instance material and every shared texture", () => {
    const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
    const disposals = textures.map((texture) => vi.spyOn(texture, "dispose"));
    let index = 0;
    const resources = createEmoteVisualResources(() => textures[index++]);
    const visual = resources.make();
    const material = (visual.object as THREE.Sprite).material as THREE.SpriteMaterial;
    const materialDispose = vi.spyOn(material, "dispose");

    visual.dispose();
    resources.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("contains animation update failures because emotes are visual-only", () => {
    const visual = {
      object: new THREE.Group(),
      pulse: vi.fn(),
      update: vi.fn(() => { throw new Error("animation failed"); }),
      dispose: vi.fn(),
    };

    expect(() => updateEmoteVisual(visual, 0.1)).not.toThrow();
    expect(visual.update).toHaveBeenCalledWith(0.1);
  });
});
