import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export interface Post {
  render(): void;
  setSize(w: number, h: number): void;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, bloomScale = 1, samples = 4): Post {
  const composer = new EffectComposer(renderer);
  // The composer renders into its own targets and BYPASSES the renderer's MSAA, so the
  // sharp bright lamp-head geometry (bulb/cone/strip edges) aliases as it moves — and
  // bloom amplifies that into the halo "flicker", worst at high resolution (desktop DPR 2,
  // why it didn't show on the lower-res phone). Multisampling the composer targets anti-
  // aliases the scene BEFORE the bloom threshold, which is what stops the shimmer.
  composer.renderTarget1.samples = samples;
  composer.renderTarget2.samples = samples;
  composer.addPass(new RenderPass(scene, camera));
  // The scene renders at full resolution; the bloom blur chain is scaled by bloomScale —
  // 1 on the high tier (devices that earn it match desktop exactly), 0.5 on the low tier
  // (same glow, ~¼ the blurred fragments — the Mali-class win; see platform/perf.ts).
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth * bloomScale, window.innerHeight * bloomScale), 0.9, 0.6, 0.85);
  composer.addPass(bloom);
  return {
    render: () => composer.render(),
    setSize: (w, h) => { composer.setSize(w, h); bloom.setSize(w * bloomScale, h * bloomScale); },
  };
}
